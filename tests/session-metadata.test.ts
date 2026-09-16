import { describe, expect, test } from "bun:test"
import {
  createReviewerSessionMetadata,
  isReviewerSessionMetadata,
  REVIEWER_SESSION_METADATA_KEY,
  REVIEWER_SESSION_METADATA_VERSION,
} from "../src/session-metadata.ts"

describe("reviewer session metadata", () => {
  test("creates the stable integration marker", () => {
    expect(createReviewerSessionMetadata("per_1")).toEqual({
      version: REVIEWER_SESSION_METADATA_VERSION,
      kind: "permission-reviewer",
      requestID: "per_1",
    })
    expect(REVIEWER_SESSION_METADATA_KEY).toBe("opencode-permission-reviewer")
  })

  test("recognizes only versioned reviewer markers", () => {
    const metadata = createReviewerSessionMetadata("per_1")
    expect(isReviewerSessionMetadata(metadata)).toBe(true)
    expect(isReviewerSessionMetadata({ ...metadata, version: 2 })).toBe(false)
    expect(isReviewerSessionMetadata({ ...metadata, kind: "subagent" })).toBe(false)
    expect(isReviewerSessionMetadata({ ...metadata, requestID: 1 })).toBe(false)
    expect(isReviewerSessionMetadata(undefined)).toBe(false)
    expect(isReviewerSessionMetadata(null)).toBe(false)
    expect(isReviewerSessionMetadata([])).toBe(false)
  })
})
