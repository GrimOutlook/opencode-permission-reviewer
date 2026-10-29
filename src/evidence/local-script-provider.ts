import { enrichLocalScriptEvidence } from "../local-script-evidence.ts"
import type { EvidenceFragment, EvidenceProvider, EvidenceProviderInput } from "./provider.ts"

/**
 * Wraps {@link enrichLocalScriptEvidence} behind the {@link EvidenceProvider}
 * surface. Produces text only (no audit trail, no preflight denial).
 */
export class LocalScriptEvidenceProvider implements EvidenceProvider {
  readonly id = "local_script"
  async collect(input: EvidenceProviderInput): Promise<EvidenceFragment> {
    const result = await enrichLocalScriptEvidence(
      input.request,
      input.directory,
      input.worktree,
      input.maxChars,
      input.scriptReadRoots,
    )
    return { kind: "local_script", text: result.text }
  }
}
