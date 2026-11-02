/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, For, Show } from "solid-js"
import { extractPermissionRequest } from "./opencode/event-normalizer.ts"
import { createUiStatus, decodeUiStatus, type ReviewUiStatus } from "./ui-protocol.ts"
import {
  HISTORY_KEY,
  HISTORY_LIMIT,
  ReviewHistory,
  reviewAppearance,
  type ReviewHistoryEntry,
} from "./review-history.ts"

function routeSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  const id = "params" in route ? route.params?.sessionID : undefined
  return route.name === "session" && typeof id === "string" ? id : undefined
}

export function installReviewHistory(
  api: TuiPluginApi,
  config: { model: string; variant: string; timeoutMs: number },
): { observe: (status: ReviewUiStatus) => void } {
  const history = new ReviewHistory()
  const [revision, setRevision] = createSignal(0)
  let hydrated = false
  const changed = () => {
    setRevision((value) => value + 1)
    if (hydrated) api.kv.set(HISTORY_KEY, history.snapshot())
  }

  createEffect(() => {
    if (hydrated || !api.kv.ready) return
    hydrated = true
    history.restore(api.kv.get(HISTORY_KEY))
    changed()
  })

  const ancestors = (sessionID: string) => {
    const result: string[] = []
    let parent = api.state.session.get(sessionID)?.parentID
    while (parent && parent !== sessionID && !result.includes(parent) && result.length < 32) {
      result.push(parent)
      parent = api.state.session.get(parent)?.parentID
    }
    return result
  }
  const observe = (status: ReviewUiStatus) => {
    history.observe(status, ancestors(status.sessionID))
    changed()
  }

  api.event.on("permission.asked", (event) => {
    const request = extractPermissionRequest(event)
    if (!request) return
    observe(createUiStatus(request, "reviewing", config))
  })
  api.event.on("tui.command.execute", (event) => {
    const status = decodeUiStatus(event.properties.command)
    if (!status) return
    observe(status)
  })
  api.event.on("permission.replied", (event) => {
    history.replied(event.properties.sessionID, event.properties.requestID, event.properties.reply)
    changed()
  })

  const entries = (sessionID: string) => {
    revision()
    return history.forSession(sessionID)
  }
  const openHistory = (sessionID = routeSessionID(api)) => {
    if (!sessionID) return
    // The host wraps replace() content in its full-screen Dialog. Nesting a
    // second Dialog applies the terminal-sized positioning a second time.
    api.ui.dialog.replace(() => (
      <box flexDirection="column" gap={1} padding={2}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={api.theme.current.text}>Permission review history</text>
          <text fg={api.theme.current.textMuted} onMouseUp={() => api.ui.dialog.clear()}>
            esc · close
          </text>
        </box>
        <text fg={api.theme.current.textMuted}>
          {entries(sessionID).length} reviews · newest first · up to {HISTORY_LIMIT} saved locally
        </text>
        <scrollbox height={Math.max(3, Math.min(24, api.renderer.height - 10))} focused>
          <box flexDirection="column" gap={1}>
            <For
              each={entries(sessionID)}
              fallback={
                <text fg={api.theme.current.textMuted}>No reviews recorded for this session.</text>
              }
            >
              {(entry) => <ReviewHistoryCard api={api} entry={entry} />}
            </For>
          </box>
        </scrollbox>
      </box>
    ))
    // replace() resets the stack size, so set it after replacing the content.
    api.ui.dialog.setSize("xlarge")
  }

  // The v1 command shim exposes both the palette entry and slash command.
  const unregister = api.command?.register(() => [
    {
      title: "Permission review history",
      value: "permission-reviewer.history",
      category: "Permission reviewer",
      enabled: routeSessionID(api) !== undefined,
      slash: { name: "permission-reviews" },
      onSelect: () => openHistory(),
    },
  ])
  if (unregister) api.lifecycle.onDispose(unregister)

  api.slots.register({
    order: 1_000,
    slots: {
      sidebar_content(_context, props) {
        // Read in the factory itself: the host subscribes the slot render pass.
        const recent = entries(props.session_id)
        return (
          <Show when={recent.length > 0}>
            <box flexDirection="column" gap={1} paddingTop={1} flexShrink={0}>
              <text fg={api.theme.current.text}>Permission reviews ({recent.length})</text>
              <For each={recent.slice(0, 3)}>
                {(entry) => (
                  <ReviewHistoryCard
                    api={api}
                    entry={entry}
                    compact
                    onOpen={() => openHistory(props.session_id)}
                  />
                )}
              </For>
              <text fg={api.theme.current.accent} onMouseUp={() => openHistory(props.session_id)}>
                View history · /permission-reviews
              </text>
            </box>
          </Show>
        )
      },
    },
  })
  return { observe }
}

function ReviewHistoryCard(props: {
  api: TuiPluginApi
  entry: ReviewHistoryEntry
  compact?: boolean
  onOpen?: () => void
}) {
  const theme = () => props.api.theme.current
  const appearance = () => reviewAppearance(props.entry)
  const shortened = (text: string, limit: number) =>
    text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  return (
    <box
      backgroundColor={theme().backgroundElement}
      border={["left"]}
      borderColor={theme()[appearance().tone]}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
      flexShrink={0}
      onMouseUp={() => props.onOpen?.()}
    >
      <text fg={theme()[appearance().tone]}>{appearance().title}</text>
      <text fg={theme().text} wrapMode="word">
        {props.compact ? shortened(props.entry.status.action, 160) : props.entry.status.action}
      </text>
      <Show when={props.entry.status.reason}>
        <text fg={theme().textMuted} wrapMode="word">
          {props.compact
            ? shortened(props.entry.status.reason ?? "", 120)
            : props.entry.status.reason}
        </text>
      </Show>
      <Show
        when={
          props.entry.status.decision?.rationale &&
          props.entry.status.decision.rationale !== props.entry.status.reason
        }
      >
        <text fg={theme().text} wrapMode="word">
          Reviewer analysis:{" "}
          {props.compact
            ? shortened(props.entry.status.decision?.rationale ?? "", 160)
            : props.entry.status.decision?.rationale}
        </text>
      </Show>
      <Show when={!props.compact}>
        <text fg={theme().textMuted} wrapMode="word">
          {new Date(props.entry.status.emittedAt).toLocaleString()} ·{" "}
          {props.entry.status.permission}
          {props.entry.status.actorName ? ` · ${props.entry.status.actorName}` : ""}
        </text>
        <text fg={theme().textMuted} wrapMode="word">
          {props.entry.status.model} · {props.entry.status.variant}
        </text>
      </Show>
    </box>
  )
}
