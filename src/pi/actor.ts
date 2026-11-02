import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ActorResolution } from "../context/actor-resolver.ts"
import { unknownResolution } from "../context/actor-resolver.ts"
import type { IntentBlock, MessageWithParts, PermissionRequest, ReviewerConfig } from "../types.ts"
import { redactSecrets } from "../redact.ts"

export const PI_ACTOR_CONTEXT_EVENT = "permission-reviewer:actor-context"
/** Trusted host-extension input. Never extracted from tool output or model prose. */
export interface PiActorContext {
  sessionID: string
  agentName?: string
  /** null explicitly identifies a root; absent means ancestry unavailable. */
  parentSessionID?: string | null
  delegatedTask?: string
  /** Original human statements supplied by the orchestrator, not its task prompt. */
  userIntent?: string[]
}

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? redactSecrets(value).slice(0, max) : undefined
}

export function normalizeActorContext(value: unknown): PiActorContext | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const sessionID = bounded(raw.sessionID, 256)
  if (!sessionID) return undefined
  const parent = raw.parentSessionID === null ? null : bounded(raw.parentSessionID, 256)
  const agentName = bounded(raw.agentName, 200)
  const delegatedTask = bounded(raw.delegatedTask, 8000)
  const userIntent = Array.isArray(raw.userIntent)
    ? raw.userIntent.slice(-20).flatMap((text) => bounded(text, 8000) ?? [])
    : []
  return {
    sessionID,
    ...(parent === undefined ? {} : { parentSessionID: parent }),
    ...(agentName ? { agentName } : {}),
    ...(delegatedTask ? { delegatedTask } : {}),
    ...(userIntent.length ? { userIntent } : {}),
  }
}

export function resolvePiActor(
  request: PermissionRequest,
  messages: MessageWithParts[],
  config: ReviewerConfig,
  contexts: ReadonlyMap<string, PiActorContext>,
): ActorResolution {
  const result = unknownResolution(
    request,
    "Pi ancestry unavailable unless supplied by a trusted delegation extension",
  )
  const current = contexts.get(request.sessionID)
  const nodes: typeof result.lineage.nodes = []
  const missing: string[] = []
  const visited = new Set<string>()
  let id: string | undefined = request.sessionID
  let root: string | undefined
  let cycle = false
  const inherited: IntentBlock[] = []
  const block = (
    text: string,
    sessionID: string,
    actor: IntentBlock["actor"],
    source: IntentBlock["provenance"]["source"],
    messageID: string,
  ): IntentBlock => ({
    text: redactSecrets(text).slice(0, config.maxIntentChars),
    sessionID,
    messageID,
    actor,
    synthetic: false,
    provenance: { value: "intent", source, confidence: "high" },
  })
  const maxNodes = Math.max(1, Math.min(config.maxSessionDepth + 1, config.maxParentSessions + 1))
  while (id && nodes.length < maxNodes) {
    if (visited.has(id)) {
      cycle = true
      break
    }
    visited.add(id)
    const context = contexts.get(id)
    nodes.push({
      sessionID: id,
      ...(context?.agentName ? { actorName: context.agentName } : {}),
      ...(context?.parentSessionID ? { parentID: context.parentSessionID } : {}),
    })
    if (id !== request.sessionID)
      for (const [index, text] of (context?.userIntent ?? []).entries())
        inherited.push(block(text, id, "user", "parent-session", `host-intent-${index}`))
    if (!context || context.parentSessionID === undefined) {
      missing.push(id)
      break
    }
    if (context.parentSessionID === null) {
      root = id
      id = undefined
      break
    }
    id = context.parentSessionID
  }
  const local: IntentBlock[] = messages
    .filter((message) => message.info.role === "user")
    .slice(-config.intentMessages)
    .flatMap((message) =>
      message.parts.flatMap((part) => {
        if (
          part.type !== "text" ||
          typeof part.text !== "string" ||
          /^Magic Compact:|^You have \d+ weighted tokens left/.test(part.text.trim())
        )
          return []
        return [
          block(part.text, request.sessionID, "user", "tool-message", message.info.id ?? "unknown"),
        ]
      }),
    )
  const delegated = Boolean(current?.parentSessionID || current?.delegatedTask)
  const direct = delegated ? inherited : local
  result.lineage = {
    nodes,
    rootSessionID: root ?? request.sessionID,
    depth: nodes.length - 1,
    cycleDetected: cycle,
    truncated: Boolean(id && !missing.length && !cycle),
    missingParents: missing,
  }
  const knownName = current?.agentName
  result.actor.agentName = {
    value: knownName,
    source: knownName ? "session-api" : "unavailable",
    confidence: knownName ? "confirmed" : "unknown",
  }
  result.actor.parentSessionID = {
    value: current?.parentSessionID ?? undefined,
    source: current?.parentSessionID !== undefined ? "session-api" : "unavailable",
    confidence: current?.parentSessionID !== undefined ? "confirmed" : "unknown",
  }
  result.actor.rootSessionID = {
    value: root ?? request.sessionID,
    source: root ? "session-api" : "unavailable",
    confidence: root ? "confirmed" : "unknown",
  }
  result.actor.delegationDepth = {
    value: nodes.length - 1,
    source: root ? "session-api" : "unavailable",
    confidence: root ? "confirmed" : "unknown",
  }
  result.actor.profile = {
    value: knownName ? (config.actorProfiles[knownName] ?? "unknown") : "unknown",
    source: knownName && config.actorProfiles[knownName] ? "global-config" : "unavailable",
    confidence: knownName && config.actorProfiles[knownName] ? "confirmed" : "unknown",
  }
  result.actor.identityCompleteness = knownName ? "partial" : "unknown"
  result.intent = {
    directUserIntent: direct,
    delegatedTask: current?.delegatedTask
      ? [
          block(
            current.delegatedTask,
            request.sessionID,
            "assistant",
            "parent-session",
            "host-delegation",
          ),
        ]
      : [],
    localSessionIntent: local,
    conflictingInstructions: [],
    completeness: root && direct.length ? "complete" : "partial",
  }
  result.completeness = {
    ...result.completeness,
    actor: Boolean(knownName),
    lineage: Boolean(root && !cycle),
    directUserIntent: direct.length > 0,
    delegatedTask: Boolean(current?.delegatedTask),
    overall: "partial",
    reasons: [
      "Pi actor evidence is host-supplied; missing ancestry remains unknown",
      ...(cycle ? ["ancestry cycle detected"] : []),
      ...(missing.length ? ["ancestry unavailable"] : []),
    ],
  }
  return result
}

export function registerActorContext(pi: ExtensionAPI): Map<string, PiActorContext> {
  const contexts = new Map<string, PiActorContext>()
  pi.events.on(PI_ACTOR_CONTEXT_EVENT, (payload: unknown) => {
    const context = normalizeActorContext(payload)
    if (context) {
      if (contexts.size >= 500 && !contexts.has(context.sessionID))
        contexts.delete(contexts.keys().next().value!)
      contexts.set(context.sessionID, context)
    }
  })
  return contexts
}
