/**
 * Runtime trust boundary against the OpenCode host.
 *
 * `@opencode-ai/plugin` and `@opencode-ai/sdk` are externalized by the bundler
 * (see tsup.config.ts) and declared as a peer range, so the plugin always runs
 * against the *consumer's* host installation rather than a package-controlled
 * copy. The lockfile pins only the development graph; it constrains nothing at
 * a consumer's site. Any host in the declared range — including releases that
 * do not exist yet — can therefore change the shapes this plugin depends on.
 *
 * A self-reported version number would be the obvious gate, but the v1 server
 * client handed to plugins exposes no version surface, and a number a host
 * asserts about itself is weaker evidence than the surfaces it actually has.
 * So the gate is a *contract probe*: enumerate every host surface the reviewer
 * depends on, check it before the plugin starts handling permissions, and
 * refuse startup when a required one is missing rather than discovering it at
 * the moment a permission needs an answer.
 *
 * Required surfaces are load-bearing for making and delivering a decision:
 * without them the reviewer cannot answer a permission request at all, and a
 * permission request that is never answered is a hang, not a safe default.
 * Degraded surfaces only cost evidence or presentation; the reviewer keeps
 * working without them and records which were absent.
 */

/** The host range this plugin declares support for (package.json peerDependencies). */
export const SUPPORTED_HOST_RANGE = ">=1.18.11 <2"

/** The host version the development graph is pinned to and tested against. */
export const VERIFIED_HOST_VERSION = "1.18.25"

export interface HostSurface {
  readonly name: string
  /** Why the reviewer needs it, used verbatim in the startup error. */
  readonly purpose: string
  readonly present: (client: Record<string, unknown>) => boolean
}

function namespace(client: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = client[key]
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function isFunction(container: Record<string, unknown>, key: string): boolean {
  return typeof container[key] === "function"
}

/** Surfaces without which the reviewer cannot answer a permission request. */
export const REQUIRED_SURFACES: readonly HostSurface[] = [
  {
    name: "client._client.post",
    purpose: "the authenticated transport used to deliver permission replies",
    present: (client) => isFunction(namespace(client, "_client"), "post"),
  },
  {
    name: "permission reply channel",
    purpose: "answering a pending permission request (raw transport or public SDK reply)",
    present: (client) =>
      isFunction(namespace(client, "_client"), "post") ||
      isFunction(client, "postSessionIdPermissionsPermissionId") ||
      isFunction(namespace(client, "permission"), "reply"),
  },
]

/** Surfaces whose absence costs evidence or presentation, never correctness. */
export const DEGRADED_SURFACES: readonly HostSurface[] = [
  {
    name: "client.session.get",
    purpose: "session lineage and actor evidence",
    present: (client) => isFunction(namespace(client, "session"), "get"),
  },
  {
    name: "client.tui.publish",
    purpose: "the review status overlay",
    present: (client) => isFunction(namespace(client, "tui"), "publish"),
  },
]

export interface HostContractResult {
  /** False when any required surface is absent; startup must not continue. */
  readonly satisfied: boolean
  readonly missing: readonly HostSurface[]
  readonly degraded: readonly HostSurface[]
}

/**
 * Probe the host client against the contract. Every check is a property-type
 * test; nothing is invoked, so the probe never throws and is safe at startup.
 */
export function verifyHostContract(client: unknown): HostContractResult {
  const record =
    typeof client === "object" && client !== null ? (client as Record<string, unknown>) : {}
  const missing = REQUIRED_SURFACES.filter((surface) => !surface.present(record))
  const degraded = DEGRADED_SURFACES.filter((surface) => !surface.present(record))
  return { satisfied: missing.length === 0, missing, degraded }
}

export function hostContractError(missing: readonly HostSurface[]): string {
  const details = missing.map((surface) => `  - ${surface.name}: ${surface.purpose}`).join("\n")
  return (
    "opencode-permission-reviewer refuses to start: this OpenCode host does not " +
    "provide the surfaces the reviewer needs.\n" +
    `Missing:\n${details}\n` +
    `Supported host range: ${SUPPORTED_HOST_RANGE} (verified against ${VERIFIED_HOST_VERSION}).\n` +
    "Starting anyway would leave permission requests unanswered rather than " +
    "safely denied, so startup fails closed."
  )
}

type Logger = (message: string, details?: unknown) => void

/**
 * Fail closed on an unverified host. Throws with an actionable message when a
 * required surface is absent; logs the degraded set otherwise so a host change
 * that silently removes evidence is visible in debug output.
 */
export function assertHostContract(client: unknown, logger?: Logger): HostContractResult {
  const result = verifyHostContract(client)
  if (!result.satisfied) throw new Error(hostContractError(result.missing))
  if (result.degraded.length > 0) {
    logger?.(
      "host contract: running degraded; some optional host surfaces are absent",
      result.degraded.map((surface) => `${surface.name} (${surface.purpose})`),
    )
  }
  return result
}
