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
  advisories it did report at the time (`@babel/core` sourceMappingURL arbitrary
  file read, `esbuild` dev-server arbitrary file read on Windows) predated this
  update and were unrelated to it; both are now closed by the `overrides` block
  described under "Transitive advisory overrides" below.
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

`@opentui/solid` also pulls `@babel/core` itself into the runtime closure. That
is where the low-severity `@babel/core` sourceMappingURL advisory used to
surface in `bun audit`; it is now closed by an override (see "Transitive
advisory overrides"). The package remains part of what a consumer installs, so
it is listed rather than filtered out.

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

## Transitive advisory overrides

Two low-severity advisories were reachable only through packages pinned by
something upstream, so no bump of a dependency we declare could close them:

| Package       | Advisory                                                                 | Affected             | How it enters                                     |
| ------------- | ------------------------------------------------------------------------ | -------------------- | ------------------------------------------------- |
| `@babel/core` | [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8) | `<= 7.29.0`          | runtime closure, via `@opentui/solid` (exact pin) |
| `esbuild`     | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | `>= 0.27.3 < 0.28.1` | development only, via `tsup` > `bundle-require`   |

Both are closed by an `overrides` block in `package.json`: `@babel/core` at
`7.29.7` and `esbuild` at `0.28.2`.

The `@babel/core` override deliberately stays inside the `7.x` major that
`@opentui/solid` was built against. That is the same reasoning as the Effect
exception above, applied in the other direction: overriding a dependency's own
framework pin across a major would trade a low-severity advisory for a real
compatibility risk in code a consumer installs, but raising the patch level
inside the chosen major does not. `esbuild` crosses a `0.x` minor (`tsup`
declares `^0.27.0`) because there is no fixed `0.27.x`; the build exercises
esbuild directly, so `bun run build` is the check that this is safe.

### How this is enforced

`tests/dependency-overrides.test.ts` fails when:

- either override is missing, or is itself inside its advisory's affected range;
- any resolution in `bun.lock` — nested copies included — is a vulnerable
  version, so a later bump cannot quietly reintroduce one;
- the `@babel/core` override leaves `7.x`;
- an override masks a package declared directly in `package.json`, which should
  be bumped in place where a reader can see it.

An override is a last resort, not a maintenance strategy. When upstream ships a
release that pins a fixed version itself, drop the corresponding entry and let
the real dependency graph govern again.
