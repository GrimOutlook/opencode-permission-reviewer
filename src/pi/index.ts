import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createAuditWriter } from "../audit.ts"
import { resolveConfig } from "../config.ts"
import { buildEvidence, buildIntentHistory, buildTranscript } from "../context.ts"
import { enforceDecision, parseDecisionFromText } from "../decision.ts"
import { emergencyBrakeReason } from "../emergency-brake.ts"
import { DEFAULT_TENANT_POLICY, REVIEWER_SYSTEM_PROMPT, buildReviewerPrompt } from "../policy.ts"
import { redactSecrets } from "../redact.ts"
import { publishResult, registerResultRenderer } from "./results.ts"
import type {
  MessageWithParts,
  PermissionRequest,
  ReviewExecutionResult,
  ReviewerConfig,
} from "../types.ts"

/** Personal configuration only: repositories cannot weaken the reviewer. */
export function loadPiConfig(
  path = join(homedir(), ".pi/agent/permission-reviewer.json"),
): ReviewerConfig {
  let options: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a configuration object")
    options = value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const config = resolveConfig({ ...options, outputFormat: "text" })
  // These require actor/capability evidence not yet supplied by the basic port.
  if (config.enforcementMode === "enforce" || config.policyRules.length > 0)
    throw new Error("Pi adapter does not yet support declarative policy rules or enforce mode")
  return {
    ...config,
    model: typeof options.model === "string" ? config.model : "",
    auditPath: config.auditPath ?? "~/.pi/agent/permission-reviewer-audit.jsonl",
  }
}

export function piRequest(
  id: string,
  sessionID: string,
  toolName: string,
  input: Record<string, unknown>,
): PermissionRequest {
  return {
    id,
    sessionID,
    permission: toolName,
    patterns: [
      typeof input.command === "string"
        ? input.command
        : typeof input.path === "string"
          ? input.path
          : toolName,
    ],
    metadata: { ...input, tool: toolName },
    always: [],
  }
}

function messagesFromPi(ctx: ExtensionContext): MessageWithParts[] {
  return ctx.sessionManager.getBranch().flatMap((entry): MessageWithParts[] => {
    if (entry.type !== "message") return []
    const message = entry.message
    if (message.role !== "user" && message.role !== "assistant") return []
    const parts =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => ({ type: "text", text: part.text }))
    return [{ info: { id: entry.id, role: message.role }, parts }]
  })
}

/** Reject invalid/failed reviewer output; preserve the shared risk/authorization gates. */
export function decidePiReview(text: string, config: ReviewerConfig): ReviewExecutionResult {
  const decision = parseDecisionFromText(text)
  return decision
    ? { ...enforceDecision(decision, config), decisionSource: "llm-reviewer" }
    : {
        kind: "escalate",
        reason: "Reviewer returned invalid output",
        decisionSource: "failure-safe",
      }
}

async function review(
  request: PermissionRequest,
  ctx: ExtensionContext,
  config: ReviewerConfig,
): Promise<ReviewExecutionResult> {
  const brake = emergencyBrakeReason(request)
  if (brake) return { kind: "deny", reason: brake, decisionSource: "emergency-brake" }
  const model = config.model
    ? (() => {
        const separator = config.model.indexOf("/")
        if (separator < 1) throw new Error("Reviewer model must be provider/model")
        return ctx.modelRegistry.find(
          config.model.slice(0, separator),
          config.model.slice(separator + 1),
        )
      })()
    : ctx.model
  if (!model) throw new Error("Reviewer model unavailable")
  const messages = messagesFromPi(ctx)
  const evidence = buildEvidence(
    {
      request,
      directory: ctx.cwd,
      worktree: ctx.cwd,
      transcript: buildTranscript(messages, config),
      intentHistory: buildIntentHistory(messages, config),
      enrichment:
        "Pi basic adapter: actor lineage, ask decisions, and external evidence enrichment are unavailable. Do not infer authorization from their absence.",
      sshAudit: [],
    },
    config,
  )
  const controller = new AbortController()
  const cancel = () => controller.abort()
  ctx.signal?.addEventListener("abort", cancel, { once: true })
  if (ctx.signal?.aborted) controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Race as well as abort: a provider ignoring cancellation must not release the gate.
    const response = await Promise.race([
      ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: REVIEWER_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: buildReviewerPrompt(
                    config.policy ?? DEFAULT_TENANT_POLICY,
                    evidence,
                    "text",
                  ),
                },
              ],
              timestamp: Date.now(),
            },
          ],
          tools: [],
        },
        { signal: controller.signal },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("Reviewer timed out"))
        }, config.timeoutMs)
      }),
    ])
    if (controller.signal.aborted || response.stopReason !== "stop")
      throw new Error("Reviewer did not complete successfully")
    return {
      ...decidePiReview(
        response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        config,
      ),
    }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener("abort", cancel)
  }
}

export default function permissionReviewer(pi: ExtensionAPI): void {
  registerPiReviewer(pi, loadPiConfig)
}

export function registerPiReviewer(pi: ExtensionAPI, loadConfig: () => ReviewerConfig): void {
  registerResultRenderer(pi)
  // Serialize approvals: tool calls from the same model response may be parallel.
  let pending = Promise.resolve()
  pi.on("tool_call", async (event, ctx) => {
    const previous = pending
    let release!: () => void
    pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    const start = performance.now()
    try {
      const config = loadConfig()
      const request = piRequest(
        event.toolCallId,
        ctx.sessionManager.getSessionId(),
        event.toolName,
        event.input,
      )
      let result: ReviewExecutionResult
      try {
        if (ctx.signal?.aborted) throw new Error("Tool call cancelled")
        result = await review(request, ctx, config)
      } catch (error) {
        result = {
          kind: "escalate",
          reason: error instanceof Error ? error.message : String(error),
          decisionSource: "failure-safe",
        }
      }
      if (result.kind === "escalate") {
        const approved =
          config.escalationMode === "manual" &&
          ctx.hasUI &&
          !ctx.signal?.aborted &&
          (await ctx.ui.confirm(
            "Permission reviewer: manual approval",
            redactSecrets(`${event.toolName}\n${JSON.stringify(event.input)}\n\n${result.reason}`),
          ))
        result = {
          ...result,
          kind: approved ? "allow" : "deny",
          reason: `${approved ? "Manually approved" : "Escalation not approved"}: ${result.reason}`,
          ...(approved ? { decisionSource: "manual-superseded" as const } : {}),
        }
      }
      if (ctx.signal?.aborted)
        result = { kind: "deny", reason: "Tool call cancelled", decisionSource: "failure-safe" }
      await createAuditWriter(config)?.({
        schemaVersion: 2,
        timestamp: new Date().toISOString(),
        durationMs: performance.now() - start,
        requestID: request.id,
        sessionID: request.sessionID,
        permission: request.permission,
        outcome: result.kind,
        reason: redactSecrets(result.reason),
        decisionSource: result.decisionSource ?? "failure-safe",
        ...(result.decision
          ? {
              riskLevel: result.decision.risk_level,
              userAuthorization: result.decision.user_authorization,
              scopeAlignment: result.decision.scope_alignment,
              confidence: result.decision.confidence,
              reviewerOutcome: result.decision.outcome,
            }
          : {}),
      })
      publishResult(pi, event.toolName, event.toolCallId, result, performance.now() - start)
      if (result.kind !== "allow")
        return { block: true, reason: `Permission reviewer: ${result.reason}` }
      return undefined
    } catch (error) {
      const reason = `Permission reviewer failed: ${error instanceof Error ? error.message : String(error)}`
      publishResult(
        pi,
        event.toolName,
        event.toolCallId,
        { kind: "deny", reason, decisionSource: "failure-safe" },
        performance.now() - start,
      )
      return { block: true, reason }
    } finally {
      release()
    }
  })
}
