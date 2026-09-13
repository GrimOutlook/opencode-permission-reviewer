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
