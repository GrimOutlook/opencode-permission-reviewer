import { redactSecrets } from "./redact.ts"
import { parseUiStatus, type ReviewUiStatus } from "./ui-protocol.ts"

export const HISTORY_KEY = "opencode-permission-reviewer.history.v1"
export const HISTORY_LIMIT = 500

export interface ReviewHistoryEntry {
  status: ReviewUiStatus
  ancestors: string[]
  reply?: "once" | "always" | "reject"
}

function clean(status: ReviewUiStatus): ReviewUiStatus {
  // Store only presentation data, not the complete model decision/evidence.
  return {
    version: 1,
    requestID: status.requestID,
    sessionID: status.sessionID,
    phase: status.phase,
    permission: status.permission,
    action: redactSecrets(status.action).slice(0, 500),
    model: status.model,
    variant: status.variant,
    emittedAt: status.emittedAt,
    timeoutMs: status.timeoutMs,
    ...(status.reason === undefined
      ? {}
      : { reason: redactSecrets(status.reason).slice(0, 2_000) }),
    ...(status.actorName === undefined ? {} : { actorName: status.actorName }),
    ...(status.escalationDisposition === undefined
      ? {}
      : { escalationDisposition: status.escalationDisposition }),
  }
}

function key(entry: ReviewHistoryEntry): string {
  return JSON.stringify([entry.status.sessionID, entry.status.requestID])
}

export class ReviewHistory {
  private entries = new Map<string, ReviewHistoryEntry>()

  observe(status: ReviewUiStatus, ancestors: string[] = []): void {
    const id = key({ status, ancestors })
    const previous = this.entries.get(id)
    // A permission reply is authoritative. A late model result must not turn
    // an already answered request back into a pending/approved review.
    if (previous?.reply !== undefined) return
    if (previous && previous.status.emittedAt > status.emittedAt) return
    this.entries.set(id, {
      status: clean(status),
      ancestors: ancestors.length > 0 ? ancestors.slice(0, 32) : (previous?.ancestors ?? []),
    })
    this.trim()
  }

  replied(sessionID: string, requestID: string, reply: string): void {
    if (reply !== "once" && reply !== "always" && reply !== "reject") return
    const id = JSON.stringify([sessionID, requestID])
    const previous = this.entries.get(id)
    if (!previous) return
    this.entries.set(id, { ...previous, reply })
  }

  restore(value: unknown): void {
    if (typeof value !== "object" || value === null) return
    const stored = value as { version?: unknown; entries?: unknown }
    if (stored.version !== 1 || !Array.isArray(stored.entries)) return
    for (const candidate of stored.entries.slice(-HISTORY_LIMIT)) {
      if (typeof candidate !== "object" || candidate === null) continue
      const record = candidate as Record<string, unknown>
      const status = parseUiStatus(record.status)
      if (!status) continue
      const reply = record.reply
      if (reply !== undefined && reply !== "once" && reply !== "always" && reply !== "reject")
        continue
      // In-flight reviews aren't persisted: restoring a spinner would imply
      // the server is still reviewing a request after a restart.
      if (status.phase === "reviewing" && reply === undefined) continue
      const ancestors = Array.isArray(record.ancestors)
        ? record.ancestors.filter((id): id is string => typeof id === "string").slice(0, 32)
        : []
      const entry: ReviewHistoryEntry = {
        status: clean(status),
        ancestors,
        ...(reply === undefined ? {} : { reply }),
      }
      const current = this.entries.get(key(entry))
      // Events received before KV hydration always win over disk state.
      if (!current) this.entries.set(key(entry), entry)
    }
    this.trim()
  }

  forSession(sessionID: string): ReviewHistoryEntry[] {
    return this.all().filter(
      (entry) => entry.status.sessionID === sessionID || entry.ancestors.includes(sessionID),
    )
  }

  snapshot(): { version: 1; entries: ReviewHistoryEntry[] } {
    return {
      version: 1,
      entries: this.all().filter(
        (entry) => entry.status.phase !== "reviewing" || entry.reply !== undefined,
      ),
    }
  }

  private all(): ReviewHistoryEntry[] {
    return [...this.entries.values()].sort(
      (left, right) =>
        right.status.emittedAt - left.status.emittedAt || key(left).localeCompare(key(right)),
    )
  }

  private trim(): void {
    for (const entry of this.all().slice(HISTORY_LIMIT)) this.entries.delete(key(entry))
  }
}

export function reviewAppearance(entry: ReviewHistoryEntry): {
  title: string
  tone: "success" | "error" | "warning" | "info"
} {
  if (entry.reply === "reject") {
    return {
      title:
        entry.status.escalationDisposition === "deny"
          ? "✕ Blocked (fail-closed)"
          : "✕ Permission denied",
      tone: "error",
    }
  }
  if (entry.reply !== undefined) return { title: "✓ Permission allowed", tone: "success" }
  if (entry.status.phase === "approved") return { title: "✓ Reviewer approved", tone: "success" }
  if (entry.status.phase === "denied") {
    return {
      title:
        entry.status.escalationDisposition === "deny"
          ? "✕ Blocked (fail-closed)"
          : "✕ Reviewer denied",
      tone: "error",
    }
  }
  if (entry.status.phase === "manual") return { title: "! Manual review required", tone: "warning" }
  return { title: "◐ Reviewing permission", tone: "info" }
}
