import { appendFile, chmod, mkdir, stat } from "node:fs/promises"
import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import type { ReviewAuditRecord, ReviewerConfig } from "./types.ts"

export const DEFAULT_AUDIT_PATH = "~/.local/share/opencode/permission-reviewer-audit.jsonl"

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

/** Resolve the audit path the way the writer does. */
export function resolveAuditPath(config: ReviewerConfig): string {
  return expandHome(config.auditPath ?? DEFAULT_AUDIT_PATH)
}

/** The required identity/decision fields every audit record must carry. Used
 *  by the report reader to flag truncated or malformed lines. */
const REQUIRED_AUDIT_FIELDS = [
  "timestamp",
  "requestID",
  "sessionID",
  "permission",
  "outcome",
  "reason",
] as const

/**
 * Upper bound on how much of the audit log a summary reads. The log is
 * append-only, so the most recent records are the interesting ones: anything
 * beyond this is skipped from the *front* and reported as truncated rather
 * than pulled into memory.
 */
export const AUDIT_SUMMARY_MAX_BYTES = 4 * 1024 * 1024

export interface AuditMissingFields {
  lineNo: number
  missing: string[]
}

export interface AuditSummary {
  path: string
  exists: boolean
  totalLines: number
  /** Whether the file was larger than `AUDIT_SUMMARY_MAX_BYTES` and only its
   *  tail was summarized. Counts and line numbers then cover that tail only. */
  truncated: boolean
  /** Size of the audit file on disk, in bytes. */
  fileBytes: number
  /** Bytes actually read and summarized. */
  scannedBytes: number
  validRecords: number
  invalidLines: number
  bySchemaVersion: Record<string, number>
  byOutcome: Record<string, number>
  byRiskLevel: Record<string, number>
  byDecisionSource: Record<string, number>
  byPermission: Record<string, number>
  unknownActorNames: Array<{ name: string; count: number }>
  missingRequiredFields: AuditMissingFields[]
  firstTimestamp?: string
  lastTimestamp?: string
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** Read an append-only JSONL audit file and summarize it. Never throws: a
 *  missing/unreadable file returns an empty summary with `exists: false`. */
export function readAuditSummary(path: string): AuditSummary {
  const summary: AuditSummary = {
    path,
    exists: false,
    totalLines: 0,
    truncated: false,
    fileBytes: 0,
    scannedBytes: 0,
    validRecords: 0,
    invalidLines: 0,
    bySchemaVersion: {},
    byOutcome: {},
    byRiskLevel: {},
    byDecisionSource: {},
    byPermission: {},
    unknownActorNames: [],
    missingRequiredFields: [],
  }
  let tail: { text: string; fileBytes: number; truncated: boolean }
  try {
    tail = readBoundedTail(path)
    summary.exists = true
  } catch {
    return summary
  }
  summary.fileBytes = tail.fileBytes
  summary.scannedBytes = Buffer.byteLength(tail.text, "utf8")
  summary.truncated = tail.truncated
  const lines = tail.text.split("\n").filter((line) => line.trim().length > 0)
  summary.totalLines = lines.length
  const actorCounts = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[i]!)
    } catch {
      summary.invalidLines++
      continue
    }
    // A bare primitive or null/array is not an audit record; count it as an
    // invalid line instead of throwing on the property accesses below.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      summary.invalidLines++
      continue
    }
    const record = parsed as Record<string, unknown>
    summary.validRecords++
    bump(summary.bySchemaVersion, String(record.schemaVersion ?? 1))
    if (typeof record.outcome === "string") bump(summary.byOutcome, record.outcome)
    bump(summary.byRiskLevel, typeof record.riskLevel === "string" ? record.riskLevel : "(none)")
    if (typeof record.decisionSource === "string")
      bump(summary.byDecisionSource, record.decisionSource)
    if (typeof record.permission === "string") bump(summary.byPermission, record.permission)
    if (typeof record.timestamp === "string") {
      if (summary.firstTimestamp === undefined || record.timestamp < summary.firstTimestamp) {
        summary.firstTimestamp = record.timestamp
      }
      if (summary.lastTimestamp === undefined || record.timestamp > summary.lastTimestamp) {
        summary.lastTimestamp = record.timestamp
      }
    }
    const missing = REQUIRED_AUDIT_FIELDS.filter((f) => record[f] === undefined)
    if (missing.length > 0) summary.missingRequiredFields.push({ lineNo, missing })
    const actor = record.actor as { name?: string; profile?: string } | undefined
    const isUnknown =
      actor === undefined ||
      actor.profile === "unknown" ||
      actor.name === undefined ||
      actor.name === ""
    if (isUnknown) {
      const name = actor?.name ?? (actor === undefined ? "(no actor field)" : "(unnamed)")
      actorCounts.set(name, (actorCounts.get(name) ?? 0) + 1)
    }
  }
  summary.unknownActorNames = [...actorCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return summary
}

/**
 * Read at most `AUDIT_SUMMARY_MAX_BYTES` from the end of the file. When the
 * file is larger, the first partial record in the window is dropped so the
 * scan always starts on a record boundary, and the result is flagged
 * truncated. Reading the tail (rather than the head) keeps the summary about
 * the most recent activity.
 */
function readBoundedTail(path: string): { text: string; fileBytes: number; truncated: boolean } {
  const fd = openSync(path, "r")
  try {
    const fileBytes = fstatSync(fd).size
    const length = Math.min(fileBytes, AUDIT_SUMMARY_MAX_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    const position = fileBytes - length
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, position + read)
      if (n === 0) break
      read += n
    }
    let text = buffer.subarray(0, read).toString("utf8")
    const truncated = fileBytes > length
    if (truncated) {
      // The window almost certainly starts mid-record; drop up to the first
      // newline so only whole records are parsed.
      const newline = text.indexOf("\n")
      text = newline === -1 ? "" : text.slice(newline + 1)
    }
    return { text, fileBytes, truncated }
  } finally {
    closeSync(fd)
  }
}

function boundedReason(reason: string): string {
  const normalized = reason.replace(/[\r\n]+/g, " ").trim()
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 2_000)}…`
}

/**
 * Make sure an existing audit file is owner-only. `appendFile`'s `mode` option
 * applies at creation, so a pre-existing world- or group-readable log would
 * keep its permissions while new records are appended to it.
 *
 * Returns false when the file exists and cannot be made private; the caller
 * then skips the append rather than leaking the record.
 */
async function ensurePrivate(
  path: string,
  logger?: (message: string, details?: unknown) => void,
): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    // No file yet: `appendFile` creates it with mode 0600.
    return true
  }
  // Anything that is not a regular file (a directory, a fifo) is left alone;
  // the append itself will fail and be logged.
  if (!info.isFile()) return true
  const mode = info.mode
  if ((mode & 0o077) === 0) return true
  try {
    await chmod(path, 0o600)
    return true
  } catch (error) {
    logger?.("audit log is not private and could not be restricted; not writing", {
      path,
      mode: (mode & 0o777).toString(8),
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export function createAuditWriter(
  config: ReviewerConfig,
  logger?: (message: string, details?: unknown) => void,
): ((record: ReviewAuditRecord) => Promise<void>) | undefined {
  if (!config.audit) return
  const path = expandHome(config.auditPath ?? DEFAULT_AUDIT_PATH)
  let ready: Promise<boolean> | undefined
  return async (record) => {
    ready ??= mkdir(dirname(path), { recursive: true }).then(() => ensurePrivate(path, logger))
    // Fail closed: a log that cannot be made owner-only is not written to, so
    // review rationales never land in a file other local users can read.
    if (!(await ready)) return
    const sanitized: ReviewAuditRecord = {
      ...record,
      reason: boundedReason(record.reason),
    }
    await appendFile(path, `${JSON.stringify(sanitized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }).catch((error) => {
      logger?.("failed to append audit record", {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}
