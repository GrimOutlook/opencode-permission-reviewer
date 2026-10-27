/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { MODE_COMMAND } from "./runtime-mode.ts"

export function installModeCommands(api: TuiPluginApi): void {
  const [mode, setMode] = createSignal<string>("connecting…")
  const send = async (action: string) => {
    try {
      const response = await api.client.tui.publish({
        body: {
          type: "tui.command.execute",
          properties: { command: `${MODE_COMMAND}${action}` },
        },
      })
      if (response.error) throw new Error("Server rejected mode command")
    } catch {
      api.ui.toast({ variant: "error", message: "Could not contact the permission reviewer." })
    }
  }
  api.event.on("tui.command.execute", (event) => {
    const command = event.properties.command
    const changed = command?.startsWith(`${MODE_COMMAND}changed.`)
    if (!changed && !command?.startsWith(`${MODE_COMMAND}state.`)) return
    const mode = command!.slice(`${MODE_COMMAND}${changed ? "changed" : "state"}.`.length)
    if (mode !== "automatic" && mode !== "human-review") return
    setMode(mode)
    if (!changed) return
    api.ui.toast({
      variant: "info",
      title: "Permission reviewer mode",
      message:
        mode === "automatic"
          ? "Automatic: allow or deny with feedback."
          : "Human review: questionable commands need your approval.",
    })
  })
  const unregister = api.command?.register(() => [
    {
      title: "Toggle permission review mode",
      value: "permission-reviewer.mode.toggle",
      category: "Permission reviewer",
      keybind: "ctrl+alt+p",
      slash: { name: "permission-review-mode" },
      onSelect: async () => {
        api.ui.dialog.clear()
        await send("toggle")
      },
    },
    ...(["automatic", "human-review"] as const).map((mode) => ({
      title: `Permission reviewer: ${mode}`,
      value: `permission-reviewer.mode.${mode}`,
      category: "Permission reviewer",
      slash: { name: `permission-review-${mode}` },
      onSelect: async () => {
        api.ui.dialog.clear()
        await send(mode)
      },
    })),
  ])
  if (unregister) api.lifecycle.onDispose(unregister)
  api.slots.register({
    slots: {
      sidebar_content() {
        const current = mode()
        return <text fg={api.theme.current.textMuted}>Review mode: {current}</text>
      },
    },
  })
  void send("get")
}
