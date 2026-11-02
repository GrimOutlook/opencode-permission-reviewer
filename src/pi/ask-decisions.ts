import { Type } from "typebox"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { redactSecrets } from "../redact.ts"
import type { AskDecision, ReviewerConfig } from "../types.ts"

export const PI_ASK_DECISION_EVENT = "permission-reviewer:ask-decision"
export const PI_ASK_TOOL = "permission_reviewer_ask"

export class PiAskDecisions {
  private readonly sessions = new Map<string, AskDecision[]>()

  record(payload: unknown): void {
    if (!payload || typeof payload !== "object") return
    const value = payload as Record<string, unknown>
    if (
      typeof value.sessionID !== "string" ||
      !value.sessionID ||
      typeof value.question !== "string" ||
      typeof value.answer !== "string"
    )
      return
    if (this.sessions.size >= 500 && !this.sessions.has(value.sessionID))
      this.sessions.delete(this.sessions.keys().next().value!)
    const decisions = this.sessions.get(value.sessionID) ?? []
    decisions.push({
      at: Date.now(),
      question: redactSecrets(value.question).slice(0, 2000),
      answer: redactSecrets(value.answer).slice(0, 2000),
    })
    this.sessions.set(value.sessionID, decisions.slice(-20))
  }

  recentFor(sessionIDs: string[]): AskDecision[] {
    return [...new Set(sessionIDs)]
      .flatMap((id) => this.sessions.get(id) ?? [])
      .sort((a, b) => a.at - b.at)
      .slice(-20)
  }
}

export function registerAskDecisions(
  pi: ExtensionAPI,
  configFor: (sessionID: string) => ReviewerConfig,
): PiAskDecisions {
  const decisions = new PiAskDecisions()
  pi.events.on(PI_ASK_DECISION_EVENT, (payload: unknown) => {
    if (!payload || typeof payload !== "object") return
    const sessionID = (payload as Record<string, unknown>).sessionID
    if (typeof sessionID !== "string") return
    try {
      if (configFor(sessionID).askDecisions) decisions.record(payload)
    } catch {
      /* Invalid config must not create authorization evidence. */
    }
  })
  pi.registerTool({
    name: PI_ASK_TOOL,
    label: "Ask user",
    description:
      "Ask the user a scoped question or request clarification. Answers are captured as scoped reviewer evidence, never blanket authorization. Use when approval intent is unclear.",
    exposure: "model-only",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
      options: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!ctx.hasUI || signal?.aborted)
        throw new Error("Asking the user requires an available approval UI and an active call")
      const answer = params.options
        ? await ctx.ui.select(params.question, params.options)
        : await ctx.ui.input(params.question)
      if (signal?.aborted) throw new Error("Question cancelled")
      const sessionID = ctx.sessionManager.getSessionId()
      if (configFor(sessionID).askDecisions)
        decisions.record({
          sessionID,
          question: params.question,
          answer: answer ?? "Dismissed by user",
        })
      return {
        content: [{ type: "text", text: answer ?? "Dismissed by user" }],
        details: undefined,
      }
    },
  })
  return decisions
}

export function scopedAskDecisions(
  decisions: PiAskDecisions,
  ctx: ExtensionContext,
  ancestors: string[],
  enabled: boolean,
): AskDecision[] {
  return enabled ? decisions.recentFor([ctx.sessionManager.getSessionId(), ...ancestors]) : []
}
