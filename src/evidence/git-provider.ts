import { enrichGitEvidence } from "../git-evidence.ts"
import type { EvidenceFragment, EvidenceProvider, EvidenceProviderInput } from "./provider.ts"

/**
 * Wraps {@link enrichGitEvidence} behind the {@link EvidenceProvider} surface.
 * Git evidence resolves the repository from the planned command's directory,
 * which the command can move with `cd` / `git -C`; `worktree` is passed through
 * so that resolved directory can be checked against the trusted roots.
 */
export class GitEvidenceProvider implements EvidenceProvider {
  readonly id = "git"
  async collect(input: EvidenceProviderInput): Promise<EvidenceFragment> {
    const result = await enrichGitEvidence(
      input.request,
      input.directory,
      input.maxChars,
      input.worktree,
    )
    return { kind: "git", text: result.text }
  }
}
