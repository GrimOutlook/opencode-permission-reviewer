# Reporting a vulnerability

This plugin makes automated safety decisions about AI-agent permissions, so
we take security bugs seriously.

Please **do not** file a public issue for a security vulnerability. Instead,
use GitHub's private vulnerability reporting:

- go to **Report a vulnerability** at
  https://github.com/Warc0s/opencode-permission-reviewer/security/advisories/new

or email the maintainer directly if the report contains sensitive details.

Include, when possible:

- a minimal reproduction (command + permission policy that triggers it),
- the affected version (`package.json` → `version`),
- the OpenCode version you run,
- the expected vs. actual safety outcome.

We will acknowledge within a few days and coordinate a fix and disclosure.

## Threat model notes

This plugin is a **defense-in-depth aid**, not a complete sandbox. It reviews
`ask`-classified actions with a second model call and fails safe to manual
review when anything is uncertain. It does not replace OpenCode's own
permission system, your model provider's safety layers, or good OS-level
hygiene. A determinedly adversarial agent may still attempt to mislead the
reviewer; the deterministic emergency brake and the untrusted-evidence prompt
mitigate but cannot fully eliminate that risk.

## Runtime trust boundary: the OpenCode host

The published bundle externalizes `@opencode-ai/plugin`, `@opencode-ai/sdk`,
`@opentui/*`, and `solid-js` (see `tsup.config.ts`). The reviewer therefore
runs against **the host installation on the consumer's machine**, not against a
copy it ships. `package.json` declares the supported host range
(`@opencode-ai/plugin` `>=1.18.11 <2`); `bun.lock` pins only this repository's
development graph and constrains nothing at a consumer's site.

Consequences we accept and manage:

- A future host release inside the declared range can change event shapes,
  transport behavior, or permission semantics without a new reviewer release.
- The v1 server client handed to plugins exposes no version surface, and a
  version a host asserts about itself is weaker evidence than the surfaces it
  actually has.

So the gate is a **contract probe**, not a version comparison
(`src/opencode/host-contract.ts`). At startup the plugin enumerates every host
surface it depends on and classifies it:

- **Required** — the authenticated transport and a permission reply channel.
  Without these the reviewer cannot answer a permission request, and an
  unanswered request is a hang rather than a safe default, so startup **fails
  closed** with a message naming the missing surface and the supported range.
- **Degraded** — session lineage (`session.get`) and the status overlay
  (`tui.publish`). Their absence costs evidence or presentation only; the
  reviewer keeps working and records what was missing in debug output.

The probe reads properties and never invokes host methods, so it is safe to run
before any permission is handled. `assertV1Host` additionally refuses a
v2-generation client outright.

`tests/host-contract.test.ts` checks the contract against the host the
development graph actually resolves to, so a host upgrade that removes a
surface fails CI here rather than a consumer's startup. When the supported
range changes, update `SUPPORTED_HOST_RANGE` and `VERIFIED_HOST_VERSION`
alongside `package.json` — the tests assert they agree.
