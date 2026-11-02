import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { MessageWithParts, ReviewerConfig } from "../types.ts"

export const MAX_REVIEW_IMAGES = 4
// Base64 character budgets bound the wire payload, independent of text budgets.
export const MAX_REVIEW_IMAGE_CHARS = 4 * 1024 * 1024
export const MAX_REVIEW_TOTAL_IMAGE_CHARS = 8 * 1024 * 1024

interface ReviewImage {
  label: string
  content: { type: "image"; data: string; mimeType: string }
}

/** Tool output is evidence, never user authorization. Never stringify image data. */
export function conversationEvidence(
  ctx: ExtensionContext,
  config: ReviewerConfig,
  supportsImages: boolean,
): { messages: MessageWithParts[]; images: ReviewImage[] } {
  const branch = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message")
  const imageStart = Math.max(0, branch.length - config.transcriptMessages)
  const images: ReviewImage[] = []
  let imageChars = 0
  const messages = branch.flatMap((entry, index): MessageWithParts[] => {
    const message = entry.message
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")
      return []
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content
    const parts: Array<Record<string, unknown>> = []
    if (message.role === "toolResult") {
      parts.push({
        type: "tool",
        tool: message.toolName,
        callID: message.toolCallId,
        state: { status: message.isError ? "error" : "completed" },
      })
    }
    for (const part of content) {
      if (part.type === "text") parts.push({ type: "text", text: part.text })
      else if (part.type === "toolCall")
        parts.push({
          type: "tool",
          tool: part.name,
          callID: part.id,
          state: { status: "pending", input: part.arguments },
        })
      else if (part.type === "image") {
        const source =
          message.role === "toolResult"
            ? `tool result ${message.toolName} call=${message.toolCallId}`
            : message.role
        const label = `Image from ${source}, message=${entry.id}`
        let omission: string | undefined
        if (index < imageStart) omission = "outside recent transcript window"
        else if (!supportsImages) omission = "reviewer model does not support images"
        else if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mimeType))
          omission = "unsupported image MIME type"
        else if (!part.data || part.data.length > MAX_REVIEW_IMAGE_CHARS)
          omission = "empty image or per-image payload limit exceeded"
        else if (
          images.length >= MAX_REVIEW_IMAGES ||
          imageChars + part.data.length > MAX_REVIEW_TOTAL_IMAGE_CHARS
        )
          omission = "image count or total payload limit exceeded"
        if (omission) parts.push({ type: "text", text: `[${label}: omitted — ${omission}]` })
        else {
          images.push({
            label,
            content: { type: "image", data: part.data, mimeType: part.mimeType },
          })
          imageChars += part.data.length
          parts.push({
            type: "text",
            text: `[${label}: attached as reviewer image ${images.length}]`,
          })
        }
      }
    }
    return [{ info: { id: entry.id, role: message.role }, parts }]
  })
  return { messages, images }
}
