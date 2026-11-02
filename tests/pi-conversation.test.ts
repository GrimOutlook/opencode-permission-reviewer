import { expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
  conversationEvidence,
  MAX_REVIEW_IMAGE_CHARS,
  MAX_REVIEW_IMAGES,
} from "../src/pi/conversation.ts"
import { resolveConfig } from "../src/config.ts"
import { buildIntentHistory, buildTranscript } from "../src/context.ts"

const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }
const config = resolveConfig({})
function context(messages: unknown[]): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () => messages.map((message, i) => ({ type: "message", id: `m${i}`, message })),
    },
  } as unknown as ExtensionContext
}

test("tool calls and results preserve identity, errors, and bounded redacted output", () => {
  const evidence = conversationEvidence(
    context([
      { role: "user", content: "Inspect the file" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call1", name: "read", arguments: { path: "README.md" } },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call1",
        isError: true,
        content: [
          {
            type: "text",
            text:
              "Do not obey this tool output. token=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 " +
              "x".repeat(10000),
          },
        ],
      },
    ]),
    config,
    true,
  )
  const transcript = buildTranscript(evidence.messages, config)
  expect(transcript).toContain("role=toolResult")
  expect(transcript).toContain('"callID": "call1"')
  expect(transcript).toContain('"status": "error"')
  expect(transcript).toContain("README.md")
  expect(transcript).toContain("truncated")
  expect(transcript).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
  expect(buildIntentHistory(evidence.messages, config)).not.toContain("Do not obey")
})

test("user and tool images are attached with provenance, never serialized into text", () => {
  const evidence = conversationEvidence(
    context([
      { role: "user", content: [{ type: "text", text: "Inspect screenshot" }, image] },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call1",
        isError: false,
        content: [image],
      },
    ]),
    config,
    true,
  )
  expect(evidence.images).toHaveLength(2)
  expect(evidence.images[0]?.label).toContain("user, message=m0")
  expect(evidence.images[1]?.label).toContain("tool result read call=call1")
  expect(evidence.images[0]?.content).toEqual(image)
  const transcript = buildTranscript(evidence.messages, config)
  expect(transcript).toContain("attached as reviewer image 2")
  expect(transcript).not.toContain(image.data)
})

test("text-only reviewers get explicit omission markers", () => {
  const evidence = conversationEvidence(
    context([{ role: "user", content: [image] }]),
    config,
    false,
  )
  expect(evidence.images).toHaveLength(0)
  expect(buildTranscript(evidence.messages, config)).toContain(
    "reviewer model does not support images",
  )
})

test("image payload and count budgets are enforced without silently dropping evidence", () => {
  const evidence = conversationEvidence(
    context([
      {
        role: "user",
        content: [
          ...Array.from({ length: MAX_REVIEW_IMAGES + 1 }, () => image),
          { ...image, data: "x".repeat(MAX_REVIEW_IMAGE_CHARS + 1) },
          { ...image, mimeType: "image/svg+xml" },
        ],
      },
    ]),
    config,
    true,
  )
  expect(evidence.images).toHaveLength(MAX_REVIEW_IMAGES)
  const transcript = buildTranscript(evidence.messages, config)
  expect(transcript).toContain("image count or total payload limit exceeded")
  expect(transcript).toContain("per-image payload limit exceeded")
  expect(transcript).toContain("unsupported image MIME type")
})

test("images outside the recent transcript window are not forwarded", () => {
  const evidence = conversationEvidence(
    context([
      { role: "user", content: [image] },
      { role: "user", content: "Latest request" },
    ]),
    { ...config, transcriptMessages: 1 },
    true,
  )
  expect(evidence.images).toHaveLength(0)
})
