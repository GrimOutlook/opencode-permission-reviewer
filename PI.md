# Experimental Pi adapter

The `./pi` entry point adapts the existing reviewer to Pi 1.4.0. OpenCode's
entry points remain unchanged. This is a basic port, not feature parity and
not an OS sandbox.

## Try the feature branch

From this repository:

```sh
bun install
bun run build
pi -e /absolute/path/to/opencode-permission-reviewer/dist/pi.js
```

For development, `pi -e /absolute/path/to/opencode-permission-reviewer/src/pi/index.ts`
also works. Load only one of these entries. The package's `pi.extensions`
manifest points at the built entry for package installation.

## Personal configuration

Create `~/.pi/agent/permission-reviewer.json` (strict JSON, not JSONC):

```json
{
  "model": "openai/your-reviewer-model",
  "timeoutMs": 30000,
  "variant": "high",
  "escalationMode": "manual",
  "audit": true
}
```

Omit `model` to use the current Pi model. An explicit model must be registered
in Pi as `provider/model` and uses Pi's authentication. No OpenCode server or
credentials are required. Project configuration and OpenCode configuration
are deliberately not loaded. Malformed personal configuration blocks calls.

Existing reviewer options such as `policy`, `riskPolicy`, and context limits
are supported. Output is always JSON in text mode. OpenCode-specific options
such as reviewer-session retention do not yet have Pi equivalents. Declarative
`policyRules` and `enforcementMode: "enforce"` are rejected rather than silently
ignored because their required evidence is not implemented.

## Reviewer reasoning

`variant` now controls reviewer reasoning through Pi's authenticated,
provider-neutral `streamSimple` API. Supported values are `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`; `none`/`off` disable optional thinking.
The shared default is `max`. Non-reasoning models receive no thinking option.
Pi translates the level to provider-specific controls and model capabilities;
a model with mandatory reasoning may not permit disabling it. Unknown variant
names fail safe instead of silently ignoring the requested control. Corrective
retries use the same reasoning setting. Changes in personal configuration apply
to subsequent reviews without restarting.

## Actor/delegation integration

Current-session human text is recovered automatically. Pi does not define a
universal subagent protocol, so actor identity and parent links stay explicitly
unknown unless a trusted orchestration extension supplies them:

```ts
pi.events.emit("permission-reviewer:actor-context", {
  sessionID: childSessionID,
  agentName: "builder",
  parentSessionID: parentSessionID,
  delegatedTask: "Implement the requested fix",
})
pi.events.emit("permission-reviewer:actor-context", {
  sessionID: parentSessionID,
  parentSessionID: null, // explicitly known root
  userIntent: ["Original human request, not an agent-generated task"],
})
```

Send these events in the reviewer host process (forward child context through
your orchestrator). Context is in-memory, bounded to 500 sessions, and must be
re-emitted after reload. Only trusted extension events supply identity; tool
results and model claims cannot. `actorProfiles` maps supplied names to profiles.
Ancestry traversal is bounded by `maxSessionDepth`/`maxParentSessions`, detects
cycles, and marks missing ancestry. Agent-authored delegation and local child
prompts stay separate from original human intent; without parent human evidence,
a delegated task has no recovered direct user authorization. Fork ancestry is
not assumed to mean delegation. This evidence does not enable declarative policy
enforcement, which remains unsupported.

## User-question capture

The `permission_reviewer_ask` tool asks a scoped question using Pi's input or
selection UI and captures the actual user answer (or dismissal). It performs no
filesystem/network operations and bypasses the review gate so clarification
cannot deadlock. Headless/cancelled questions fail closed. `askDecisions: false`
disables capture and evidence inclusion, not the ability to ask a question.

Other trusted question extensions can forward actual UI answers with:

```ts
pi.events.emit("permission-reviewer:ask-decision", {
  sessionID,
  question: "Deploy to which environment?",
  answer: "Staging only",
})
```

Pi's general UI prompt events do not expose answers, so arbitrary third-party
question dialogs cannot be captured automatically. Never forward model-authored
tool output as a user answer. Captures are redacted, bounded, in-memory, and
scoped to the requesting session and resolved ancestors, never siblings. They
are evidence about the specific question, not blanket permission. Recent scoped
answers appear in `USER_ASK_DECISIONS` and audit records. Reload clears captures.

## Commands

Use these commands to control how **questionable calls (escalations)** are handled:

| Command                       | Behavior                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `/permission-reviewer manual` | Ask for your approval; deny if no approval UI is available.                            |
| `/permission-reviewer deny`   | Deny without prompting, returning the reviewer's reasoning to the agent.               |
| `/permission-reviewer status` | Show the effective mode and whether it comes from configuration or a session override. |
| `/permission-reviewer reset`  | Remove the session override and use personal configuration again.                      |
| `/permission-reviewer`        | Same as `status`.                                                                      |

Overrides apply only to the current session and subsequent reviews. They are
in-memory: reloading/restarting the extension clears them. To choose a lasting
default, set `escalationMode` in the personal configuration above. Already-running
reviews keep their original mode. Explicit reviewer denials and emergency-brake
blocks remain blocked in either mode. Both modes still display the result and
reason in the main transcript; `deny` also returns it as the tool's error.

## Behavior

- **Every model-issued tool call is reviewed**, including read-only and custom
  tools; there is no fast allowlist in this initial adapter. Nested calls routed
  through Pi's normal tool execution hooks are reviewed too.
- The shared emergency brake runs before the model. The reviewer receives the
  normalized request, bounded transcript and user-intent history, and the shared
  tenant policy. Conversation evidence includes tool calls and tool-result text
  with tool names, call IDs, and error/completion status. Tool output remains
  untrusted evidence, not user authorization; text uses the existing redaction
  and truncation limits.
- Bash commands that name an explicit local interpreter script (Python, Node,
  Bun, shell, Ruby, or Perl) get the shared read-only local-script inspection.
  Evidence includes bounded script content, a hash, and static capability
  signals. Relative paths follow parsed `cd` commands, but approved roots remain
  the original Pi working directory. Sensitive paths, binary files, and symlinks
  escaping that root are not included. Inline code, module execution, stdin,
  and dynamic paths are not treated as explicit script files. Missing or blocked
  scripts are marked in the evidence, not automatically approved or denied.
  Scripts are never executed by the inspector. Content uses existing redaction
  and `maxEnrichmentChars` limits.
- SSH commands receive the shared bounded `SSH_ANALYSIS`: destination/options,
  remote-command signals, and safe local executable-stdin inspection. No SSH
  connection is made. Missing executable stdin is rejected before a reviewer
  call; other incomplete evidence remains a reviewer judgment. Audit records
  include SSH summaries with remote commands represented by hashes.
- Relevant Git mutations receive shared bounded `GIT_STATE_ANALYSIS`: branch,
  staged/unstaged/untracked paths, planned targets, and potential discarded
  changes. Queries are read-only, bounded, non-interactive, and use the existing
  hook/locking safeguards. Planned staging is never confused with current staging.
- Recent user and tool-result images are attached as actual image blocks when
  the reviewer model advertises image support. Source-message labels link them
  to the text transcript. At most four images are forwarded, with base64 payload
  limits of 4 MiB per image and 8 MiB total, from the `transcriptMessages` window.
  PNG, JPEG, GIF, and WebP are supported. Text-only models, unsupported formats,
  and over-budget images receive explicit omission markers instead.
  **Image pixels cannot be secret-redacted**: screenshots may expose credentials
  to the configured reviewer provider. Images are never serialized as base64
  into textual evidence, decision entries, or the audit log.
- The reviewer is a separate, tool-free model request, not a child agent. It
  cannot execute tools and its output is not appended to the primary transcript.
- The existing structured decision parser and risk/authorization/confidence
  gates determine automatic approval. Malformed text gets one corrective retry
  against the same evidence. Valid denials/escalations, provider errors, and
  truncated/aborted responses are not retried. Each attempt has `timeoutMs`;
  a second invalid response, errors, or timeouts escalate rather than auto-approve.
- Manual escalation uses Pi's confirmation UI when available. `escalationMode:
"deny"` or an unavailable UI denies escalation. Explicit reviewer denials and
  emergency-brake denials do not offer an override in this extension.
- Tool calls are serialized to avoid overlapping confirmation dialogs. A
  cancelled call cannot be released by a late reviewer response. The provider
  is aborted on timeout, with an independent timeout race in case it ignores
  cancellation.
- Each completed review appears in the **main transcript** with its final
  allow/deny outcome, tool name, reason, elapsed time, decision source, and
  risk/confidence when available. Fail-closed configuration and audit errors
  also appear there. Results are persisted as display-only session entries,
  so they remain visible on resume without entering the model's context or
  triggering another turn. Secrets and terminal control sequences are removed
  from displayed text.
- Audit records default to `~/.pi/agent/permission-reviewer-audit.jsonl`, using
  the shared private-file writer. Audit write failure blocks execution when
  auditing is enabled.

## Limitations

No native cross-extension subagent discovery, status overlay, review-history UI, persistent session approvals, or
reviewer usage aggregation has been ported yet. Treat missing evidence
conservatively. The full OpenCode review coordinator is not used; the Pi gate
shares its lower-level prompt, parsing, risk gates, emergency brake, redaction,
and audit components.

Approval hooks are guardrails, not containment: they do not mediate direct
operations performed by trusted extensions, and this entry does not intercept
user-entered `!`/`!!` shell commands. Other loaded extensions are trusted code;
do not assume a tool gate protects against them. Use OS isolation for a hard
filesystem/network boundary.

## Verification

`tests/pi.test.ts` exercises request normalization, shared decision gates,
successful approval, provider failures, malformed/truncated output, and
cancellation using a fake Pi host. `tests/pi-results.test.ts` covers result
redaction and transcript rendering, including narrow terminal widths. Live provider/UI behavior still needs a
manual smoke test in Pi; the automated suite does not contact a model provider.
