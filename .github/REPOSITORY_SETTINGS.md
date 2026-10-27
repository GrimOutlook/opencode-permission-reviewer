# Repository maintenance

Canonical fork: `GrimOutlook/opencode-permission-reviewer`; release branch: `main`.
License and upstream attribution remain Apache-2.0.

## Required checks and pull requests

`main` requires a PR, an up-to-date branch, resolved conversations, and successful
`ci` and `codeql` checks from GitHub Actions. Protection includes administrators;
force pushes and branch deletion are disabled. Squash merging preserves linear
history; merged branches are automatically deleted.

This is a single-maintainer repository, so a second approving review is not
required: GitHub does not allow authors to approve their own PRs. CODEOWNERS
routes reviews to `@GrimOutlook`. Add a required independent/code-owner approval
when another maintainer can provide it.

The desired protection is versioned in `branch-protection.json`. An administrator
can reapply it from the repository root:

```sh
gh api --method PUT repos/GrimOutlook/opencode-permission-reviewer/branches/main/protection \
  --input .github/branch-protection.json
```

## Automation and security

- CI runs on PRs, pushes to `main`/`dev`, and weekly, with manual dispatch available.
  Stable aggregate checks fail if any prerequisite fails or is cancelled.
- CI checks the supported Bun versions, formatting, lint, typechecking, tests,
  packaging/build, coverage, and high/critical dependency advisories.
- CodeQL runs on PRs, pushes, and weekly, using the extended security suite.
- Actions are SHA-pinned. Workflows use read-only permissions by default;
  CodeQL gets security-event write access only in its analysis job. Checkout
  credentials are not persisted in CI. Jobs have timeouts; stale runs cancel.
- Dependabot version-update PRs target `main`, with a seven-day cooldown for
  Bun and GitHub Actions. Local package resolution also has a seven-day age
  gate. See [DEPENDENCIES.md](../DEPENDENCIES.md).
- Dependency alerts, private vulnerability reporting, secret scanning, and
  secret push protection are enabled. Security reports go to this fork.
- Default workflow tokens are read-only and cannot approve PRs. Full action
  SHA pinning is enforced in repository Actions settings.
- The release workflow defaults to read-only permissions; only its release job
  requests the write permissions needed for publication and provenance.

## Releases

The inherited tag-driven release workflow builds/tests the package, verifies
that the tag is reachable from `main`, and publishes with provenance, checksums,
and an SBOM. The npm package name is still `opencode-permission-reviewer`;
publishing requires rights to that package and an `NPM_TOKEN`. Repository
hardening does not create an npm token or publish a release. Coordinate package
ownership or rename the package before attempting an independent fork release.
