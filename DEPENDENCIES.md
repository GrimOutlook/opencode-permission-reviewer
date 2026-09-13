# Dependency policy

How this project treats its dependency graph. Kept in the repository (not under
`docs/`, which is git-ignored and local-only) so the reasoning ships with the
code and survives maintainer turnover.

## Documented exception: the prerelease Effect dependency

`@opencode-ai/plugin` depends on `effect@4.0.0-beta.83`, a prerelease. A
prerelease carries more compatibility and maintainer risk than a stable release
and widens the build/test trust graph, so it is an exception that needs stating
rather than a default we are comfortable with.

### Why it is not removed

It is not ours to remove. `effect` is a direct dependency of
`@opencode-ai/plugin`, and every current release of that package pins the same
prerelease:

| `@opencode-ai/plugin` | `effect`        |
| --------------------- | --------------- |
| 1.18.25 (pinned here) | `4.0.0-beta.83` |
| 1.18.26               | `4.0.0-beta.83` |
| 1.18.28               | `4.0.0-beta.83` |
| 1.18.30 (`latest`)    | `4.0.0-beta.83` |

Upgrading the host package does not reach a stable Effect, and overriding a
transitive pin of the host's own framework would be worse than the problem: it
would run the host's code against a version it was not built or tested on.

### Why the exposure is bounded

`@opencode-ai/plugin` is a **devDependency and a peer dependency**, never a
runtime dependency. `tsup.config.ts` externalizes it, so nothing from that
graph — Effect included — is bundled into `dist/` or installed by a consumer.
At a consumer's site the host supplies its own copy; the version in `bun.lock`
governs this repository's type-checking, tests, and build only.

So the blast radius is the maintainer and CI machines, not the people running
the plugin. That is a real surface (a compromised build-time package can alter
what ships), which is why the release pipeline pins its actions to commit SHAs,
publishes with provenance, and verifies that the published artifact matches the
inspected one.

## Other prereleases in the graph

One prerelease _is_ reachable from this package's runtime dependencies:
`gensync@1.0.0-beta.2`, reached through `@opentui/solid` → `@babel/core`. It is
a prerelease by version string only: `1.0.0-beta.2` has been Babel's published
`latest` for years and is not an unreleased development build. It is recorded
here so the enforcement test can distinguish "known and assessed" from "new and
unreviewed".

`@opentui/solid` also pulls `@babel/core` itself into the runtime closure, which
is where the low-severity `@babel/core` sourceMappingURL advisory surfaces in
`bun audit`. It is not reachable from the reviewer's decision path — the TUI
overlay is compiled by OpenCode's host pipeline — but it is part of what a
consumer installs, so it is listed rather than filtered out.

### Monitoring expectations

- Re-check on each `@opencode-ai/plugin` bump whether it has moved to a stable
  Effect; if it has, take that upgrade and delete this exception.
- Run `bun audit` before a release; treat an advisory against `effect` or its
  graph as a release blocker until assessed.
- Never add `effect` as a direct dependency of this package.

### How this is enforced

`tests/prerelease-dependencies.test.ts` fails when:

- `effect` becomes reachable from this package's runtime dependencies;
- the published bundle contains Effect code;
- the pinned Effect version stops matching the one documented here (so a bump
  forces a fresh review rather than passing silently);
- the runtime dependency closure reaches a prerelease that is not one of the
  documented ones above.
