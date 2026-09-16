# Contributing

Thanks for considering a contribution. This plugin makes automated safety
decisions, so changes need to be deliberate and well-tested.

## Setup

```bash
git clone https://github.com/Warc0s/opencode-permission-reviewer.git
cd opencode-permission-reviewer
bun install
bun run check   # typecheck + tests — must pass before any push
```

## Before you open a PR

1. **`bun run check` is green** (typecheck + full test suite, including the
   stress suite). Do not disable tests to make this pass.
2. **No personal data or secrets in code or tests.** Use clearly-synthetic
   fixtures (e.g. `sk-syntheticcredential...`, documentation IP ranges
   `192.0.2.x` / `203.0.113.x` / `198.51.100.x`, `*.invalid` hostnames). Never
   commit real tokens, keys, personal filesystem paths, or internal codenames.
3. **Safety changes need tests.** Any change to `decision.ts`, `policy.ts`,
   `emergency-brake.ts`, or the runtime enforcement path must include tests
   that demonstrate the invariant (e.g. critical risk can never be approved).
4. **Keep behavior changes backward-compatible** unless you're intentionally
   bumping a version pin or an enforcement invariant, and say so in the PR.
5. **Keep user-facing strings in English.** The policy and reviewer prompts are
   English; runtime/UI messages should be too so the plugin is usable globally.

## Areas that need care

- `src/decision.ts` / `src/policy.ts` / `src/emergency-brake.ts` — these encode
  safety invariants. Document the reasoning for any change.
- The v1 adapter and isolated reply transport
  (`src/opencode/v1-adapter.ts`, `src/opencode/reply-transport.ts`) reach into
  OpenCode's authenticated SDK transport; changes there must keep the graceful
  "refusing unsafe partial startup" behavior.
- The reviewer runs **tool-free**; never add tool access to reviewer sessions.
- The TUI entry must stay **raw TSX** (see [Build output](#build-output-dist)
  below). Do not reintroduce a prebundled `dist/tui.js`.

## Build output (`dist/`)

- `bun run build` runs tsup to bundle the server and CLI into `dist/index.js`
  and `dist/explain.js`, then runs `bun scripts/copy-tui.ts` to copy the slim
  TUI source graph into `dist/tui/` as **raw TSX**.
- The TUI must stay unbundled: OpenCode's host compiles plugin `.tsx` with its
  own Solid/OpenTUI pipeline, and a prebundled TUI does not render. When you
  touch the TUI, keep the file list in `scripts/copy-tui.ts` in sync with the
  imports of `src/tui.tsx` and its copied modules (no server engine, no
  `node:` builtins).
- `dist/` is gitignored; never commit build output. `tests/package-smoke.test.ts`
  verifies the packed tarball ships exactly the expected set (including the raw
  TUI files and the absence of a prebundled TUI).
- Run `bun run build` (or `bun run check`, which ends with a build) after a
  fresh clone. Installing dependencies does **not** build for you — see below.

### Why the build runs in `prepack`, not `prepare`

npm runs `prepare` in three situations: packing/publishing, installing the
package's own directory, and **installing the package from a Git URL or a local
path**. That last one means a `prepare` build executes `tsup` and
`scripts/copy-tui.ts` on the installing machine, before anyone can inspect what
they installed — a package lifecycle script is code execution at install time,
which is exactly the surface supply-chain attacks use.

The build lives in `prepack` instead. `prepack` runs when the tarball is
created (`npm pack`, `npm publish`), so:

- the published package still ships a fully built `dist/` — consumers installing
  from the registry get generated artifacts and run **no** build;
- `tests/package-smoke.test.ts` and the release workflow still pack a real,
  freshly built tarball;
- installing this package from a Git URL no longer runs a build on the
  installer's machine. It also will not produce a working `dist/`, which is
  intended: the registry is the supported install path (`bun add
opencode-permission-reviewer`), and failing visibly beats building silently.

This package declares **no** `install`, `preinstall`, or `postinstall` scripts,
and `tests/lifecycle-scripts.test.ts` fails if one is added. Keep the build's
dependency set small for the same reason — everything `bun run build` touches is
code that runs during a release.

## Live (end-to-end) testing

`tests/live-harness.ts` runs against a real OpenCode server and model and is
**not** part of `bun test`. Run it manually only when you have a local server
and a configured reviewer model:

```bash
opencode serve &   # then point the harness at it
bun run tests/live-harness.ts http://127.0.0.1:41973 --smoke
```
