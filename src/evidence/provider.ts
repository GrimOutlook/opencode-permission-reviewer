import type { PermissionRequest } from "../types.ts"
import type { SshAuditSummary } from "../ssh-evidence.ts"

/**
 * A single piece of evidence gathered about a permission request. The runtime
 * only consumes `text`, `audit`, and `preflightDenial` today; the remaining
 * fields give future providers room to surface warnings and cost without
 * changing the interface.
 */
export interface EvidenceFragment {
  kind: "ssh" | "local_script" | "git"
  text: string
  audit?: SshAuditSummary[]
  preflightDenial?: string
  warnings?: string[]
  durationMs?: number
}

export interface EvidenceProviderInput {
  request: PermissionRequest
  directory: string
  worktree: string
  maxChars: number
  scriptReadRoots?: string[]
}

/**
 * Enriches a permission request with one category of evidence (SSH analysis,
 * local script inspection, Git state, …). Providers run concurrently and their
 * fragments are assembled into a single review envelope.
 */
export interface EvidenceProvider {
  readonly id: string
  collect(input: EvidenceProviderInput): Promise<EvidenceFragment>
}
