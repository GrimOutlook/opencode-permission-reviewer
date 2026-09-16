/**
 * Stable metadata contract for integrations that need to identify reviewer
 * child sessions. Metadata is an integration marker, not an authorization
 * boundary: external plugins must still treat its contents as advisory.
 */
export const REVIEWER_SESSION_METADATA_KEY = "opencode-permission-reviewer"
export const REVIEWER_SESSION_METADATA_VERSION = 1 as const

export interface ReviewerSessionMetadata {
  version: typeof REVIEWER_SESSION_METADATA_VERSION
  kind: "permission-reviewer"
  requestID: string
}

export function createReviewerSessionMetadata(requestID: string): ReviewerSessionMetadata {
  return {
    version: REVIEWER_SESSION_METADATA_VERSION,
    kind: "permission-reviewer",
    requestID,
  }
}

export function isReviewerSessionMetadata(value: unknown): value is ReviewerSessionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const metadata = value as Record<string, unknown>
  return (
    metadata.version === REVIEWER_SESSION_METADATA_VERSION &&
    metadata.kind === "permission-reviewer" &&
    typeof metadata.requestID === "string"
  )
}
