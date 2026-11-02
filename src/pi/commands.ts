import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { EscalationMode, ReviewerConfig } from "../types.ts"

/** Overrides belong to a session, never to the repository or another session. */
export function registerReviewerCommands(
  pi: ExtensionAPI,
  loadConfig: () => ReviewerConfig,
): (sessionID: string) => ReviewerConfig {
  const overrides = new Map<string, EscalationMode>()
  const effectiveConfig = (sessionID: string): ReviewerConfig => {
    const config = loadConfig()
    return { ...config, escalationMode: overrides.get(sessionID) ?? config.escalationMode }
  }
  pi.registerCommand("permission-reviewer", {
    description:
      "Questionable calls: manual approval or deny with reason (manual|deny|status|reset)",
    handler: async (args, ctx) => {
      const action = args.trim() || "status"
      const sessionID = ctx.sessionManager.getSessionId()
      if (!["manual", "deny", "status", "reset"].includes(action)) {
        ctx.ui.notify("Usage: /permission-reviewer [manual|deny|status|reset]", "warning")
        return
      }
      try {
        // Validate before changing the override: invalid configuration remains fail-closed.
        const config = loadConfig()
        if (action === "manual" || action === "deny") overrides.set(sessionID, action)
        if (action === "reset") overrides.delete(sessionID)
        const mode = overrides.get(sessionID) ?? config.escalationMode
        const source = overrides.has(sessionID) ? "session override" : "personal configuration"
        const behavior =
          mode === "manual"
            ? "Ask you to approve questionable calls; deny when no approval UI is available."
            : "Deny questionable calls and return the reviewer's reasoning to the agent."
        ctx.ui.notify(
          `Permission reviewer: ${mode} (${source}). ${behavior} Explicit denials remain blocked. Changes affect subsequent reviews.`,
          "info",
        )
      } catch (error) {
        ctx.ui.notify(
          `Permission reviewer configuration error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        )
      }
    },
  })
  return effectiveConfig
}
