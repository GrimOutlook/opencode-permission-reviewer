# Dependency policy

How this project treats its dependency graph, and the record of what was
checked when a pin moved. Kept in the repository (not in `docs/`, which is
git-ignored and local-only) so the reasoning ships with the code and survives
maintainer turnover.

## Pinned runtime dependencies (OpenTUI, Solid)

`@opentui/core`, `@opentui/solid`, and `solid-js` are pinned to exact versions
(no `^`, no `~`) because they carry native, platform-specific artifacts and
because the TUI overlay is compiled by OpenCode's host pipeline, where a patch
difference can change rendering behavior. Exact pins make every change to that
graph an explicit, reviewable commit.

Exact pinning only helps if the pins are actually revisited. Dependabot's npm
ecosystem entry (`.github/dependabot.yml`) opens weekly PRs against `dev`; this
file records what was checked when a pinned version moves, so "still on an old
patch" is a decision rather than an oversight.

### Review checklist

For each pinned package in a proposed update:

1. Read the release notes / commit range between the current and proposed
   version. Note any change to native code, FFI surfaces, or input handling.
2. Check advisories for the package and its dependency graph (`bun audit`).
3. Confirm the transitive graph shape is unchanged, or record what changed —
   for the OpenTUI packages this means the `bun-ffi-structs` version and the
   set of `@opentui/core-*` platform packages in `bun.lock`.
4. Run the full gate: `bun run check` (format, lint, typecheck, tests, build),
   which includes the TUI slot-contract and overlay-loader tests and the
   package smoke test.
5. Record the outcome below.

If a pin is deliberately held back, say so here with the reason, so the next
reviewer does not have to re-derive it.

### Log

#### 2026-09-12 — `@opentui/core` / `@opentui/solid` 0.5.9 → 0.5.11

- Registry `latest` for both packages was 0.5.11 (0.5.10 released 2026-09-01,
  0.5.11 released 2026-09-07). 0.5.9 dated 2026-08-27.
- Dependency graph shape unchanged: `@opentui/core` still depends on
  `bun-ffi-structs@0.3.1`, `diff@9.0.0`, `marked@17.0.1`, `string-width@7.2.0`,
  `strip-ansi@7.1.2`, with the same eight optional `@opentui/core-*` platform
  packages (now at 0.5.11). `@opentui/solid` still peers on `solid-js@1.9.12`,
  which is unchanged here.
- `bun audit` reports no advisory against any `@opentui/*` package. The two low
  advisories it does report (`@babel/core` sourceMappingURL arbitrary file read,
  `esbuild` dev-server arbitrary file read on Windows) predate this update and
  are unrelated to it; neither is reachable from the shipped plugin at runtime.
- Full gate green on 0.5.11 (format, lint, typecheck, 598 tests, build).

Outcome: updated.

## Native dependency exposure

Native artifacts have a larger compromise and install-time impact surface than
ordinary JavaScript packages: they are opaque binaries, they are selected by
platform at install time, and a compromised one runs with the user's full
privileges the moment it is loaded. This plugin's job is to be trustworthy
about permissions, so the native code a consumer install can reach is
enumerated rather than assumed.

### Trusted runtime native set

Reachable from `dependencies` — i.e. installed at a consumer's site:

- `@opentui/core-linux-x64` and `@opentui/core-linux-x64-musl` — OpenTUI's
  renderer for the review overlay, Linux x64 (glibc and musl).
- `@opentui/core-linux-arm64` and `@opentui/core-linux-arm64-musl` — the same,
  Linux arm64.
- `@opentui/core-darwin-x64` and `@opentui/core-darwin-arm64` — the same, macOS.
- `@opentui/core-win32-x64` and `@opentui/core-win32-arm64` — the same, Windows.
- `bun-ffi-structs@0.3.1` — the FFI struct bridge `@opentui/core` uses to call
  that binary.

The eight `@opentui/core-*` packages are `optionalDependencies` of
`@opentui/core`; a package manager installs only the one matching the host
platform, so the _installed_ exposure is one native package plus the FFI
bridge. They cannot be pruned from the manifest — the selection happens at the
consumer's install, not ours.

`bun-ffi-structs` is the one to watch: it is an uncommon, FFI-adjacent package
with a small maintainer footprint. Nothing malicious was found in it and it
declares no lifecycle scripts, but it sits directly on the path between
JavaScript and native memory. Treat an ownership change, a maintainer change,
or a new lifecycle script in it as a release blocker until reviewed.

### Development-only native tooling

Confined to `devDependencies` and never reachable from the published package:
`@esbuild/*` and `@rollup/*` (bundling), `@msgpackr-extract/*` and
`@napi-rs/*` (transitively, via the lint/build graph), and `fsevents` (macOS
file watching). These run on maintainer and CI machines only.

### How this is enforced

`tests/native-dependencies.test.ts` parses `bun.lock`, walks the dependency
closure from `package.json` `dependencies`, and fails when:

- the runtime closure reaches a native package outside the trusted set above;
- any native package appears in the lockfile that is neither in the trusted
  runtime set nor in the known development tooling families;
- development-only native tooling leaks into the runtime closure;
- the FFI bridge stops being a single, exactly pinned package, or its pinned
  version stops matching the one documented here.

So a new native dependency entering the graph — through a direct bump or a
transitive one — is a deliberate review step rather than a silent lockfile
change. CI installs with `--frozen-lockfile`, so the lockfile this check reads
is the one that is actually used.

### Monitoring expectations

When any package in the trusted runtime set moves:

1. Read the release range for changes to native code, FFI surfaces, or input
   handling.
2. Check advisories (`bun audit`) for the package and its graph.
3. Confirm the set of platform packages and the `bun-ffi-structs` version in
   `bun.lock` are unchanged, or record what changed and why it is acceptable.
4. Run the full gate (`bun run check`) — the TUI tests are what would catch a
   renderer regression.
