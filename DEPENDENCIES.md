# Dependency policy

How this project treats its dependency graph. Kept in the repository (not under
`docs/`, which is git-ignored and local-only) so the reasoning ships with the
code and survives maintainer turnover.

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
