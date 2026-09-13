import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseJsonc } from "./jsonc.ts"
import { resolveConfig, DEFAULT_CONFIG, DEFAULT_RISK_POLICY } from "../config.ts"
import type { PolicyRule, ReviewerConfig } from "../types.ts"

/** Read a JSONC config file; return an empty record on any error (missing,
 *  unreadable, or malformed). Never throws. */
function readConfigFile(path: string): Record<string, unknown> {
  try {
    return parseJsonc(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

/** Optional override used by unit tests so a developer's personal global config
 *  cannot leak into loader assertions. Production always uses the real path. */
let globalConfigPathOverride: string | undefined

/** Path to the global user config. Exposed for testability. */
export function globalConfigPath(): string {
  return (
    globalConfigPathOverride ?? join(homedir(), ".config", "opencode", "permission-reviewer.jsonc")
  )
}

/** Test-only: redirect (or clear) the global config path. */
export function setGlobalConfigPathForTests(path: string | undefined): void {
  globalConfigPathOverride = path
}

/** Path to the project-local config. Exposed for testability. */
export function projectConfigPath(directory: string): string {
  return join(directory, ".opencode", "permission-reviewer.jsonc")
}

/**
 * Fields only trusted (global/inline) config may set. A checked-out repository
 * must not be able to choose which model reviews its own permission requests,
 * rewrite the safety policy that is inserted into the reviewer prompt, change
 * how the decision is transported, redirect the audit trail, delegate actor
 * profiles, or keep reviewer sessions (which hold the evidence) around.
 */
const TRUSTED_ONLY_FIELDS = [
  "model",
  "variant",
  "outputFormat",
  "policy",
  "retainReviewSessions",
  "auditPath",
  "actorProfiles",
] as const

/**
 * Evidence and reliability budgets. A project may only ask for MORE — shrinking
 * them hides the authorization or action detail the reviewer decides on, and a
 * short timeout forces the failure path. `resolveConfig` still clamps every
 * value to its hard maximum, so raising is bounded.
 */
const EVIDENCE_BUDGET_FIELDS = [
  "timeoutMs",
  "maxContextChars",
  "maxPartChars",
  "maxEnrichmentChars",
  "maxIntentChars",
  "transcriptMessages",
  "intentMessages",
  "historyMessages",
  "maxSessionDepth",
  "maxParentSessions",
] as const

/** Load and merge config from global, project, and inline sources.
 *
 * Precedence (lowest to highest): builtin defaults → global → project → inline.
 * The trust boundary ensures project config can only TIGHTEN security-sensitive
 * fields, never weaken them (lower confidence thresholds, widen risk cells,
 * disable audit, set trusted repository trust, or enable enforcement). Fields
 * that decide *who reviews* and *on what evidence* — the reviewer model and
 * variant, the decision transport, the policy prompt, session retention, the
 * audit destination, actor delegation — are trusted-only, and evidence budgets
 * may only be raised.
 *
 * When no global or project files exist (the common case), the result is
 * byte-identical to calling `resolveConfig(inlineOptions)` directly. */
export function loadResolvedConfig(
  inlineOptions: Record<string, unknown> | undefined,
  directory?: string,
): ReviewerConfig {
  const globalRaw = readConfigFile(globalConfigPath())
  const projectRaw = directory !== undefined ? readConfigFile(projectConfigPath(directory)) : {}

  // The trusted baseline is seeded with builtin defaults so clamping always
  // has a floor to compare against, even when global/inline omit a field.
  const trusted: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
    ...globalRaw,
    ...(inlineOptions ?? {}),
  }
  const merged = mergeWithTrustBoundary(trusted, projectRaw)
  return resolveConfig(merged)
}

/** Merge the trusted baseline with the untrusted project layer. Project config
 *  can only TIGHTEN security-sensitive fields, never weaken them. */
function mergeWithTrustBoundary(
  trusted: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const clamped = { ...project }

  // confidenceThreshold: project can raise but not lower it.
  if (
    typeof clamped.confidenceThreshold === "number" &&
    typeof trusted.confidenceThreshold === "number" &&
    clamped.confidenceThreshold < trusted.confidenceThreshold
  ) {
    clamped.confidenceThreshold = trusted.confidenceThreshold
  }

  // audit: project can enable but not disable.
  if (clamped.audit === false && trusted.audit !== false) {
    delete clamped.audit
  }

  // Trusted-only fields (audit destination, reviewer model/variant, decision
  // transport, policy prompt text, session retention, actor delegation): the
  // project layer cannot set them at all.
  for (const field of TRUSTED_ONLY_FIELDS) delete clamped[field]

  // Evidence budgets: project can raise, never lower.
  for (const field of EVIDENCE_BUDGET_FIELDS) {
    const projectValue = clamped[field]
    if (typeof projectValue !== "number" || !Number.isFinite(projectValue)) {
      delete clamped[field]
      continue
    }
    const trustedValue = trusted[field]
    if (typeof trustedValue === "number" && Number.isFinite(trustedValue)) {
      clamped[field] = Math.max(projectValue, trustedValue)
    }
  }

  // repositoryTrust: project cannot set "trusted" — only global/inline can.
  if (clamped.repositoryTrust === "trusted") {
    delete clamped.repositoryTrust
  }

  // enforcementMode: project cannot enable OR disable enforcement — only
  // global/inline can. A project "enforce" is deleted (can't enable), and a
  // project "observe" when the trusted baseline is "enforce" is also deleted
  // (can't downgrade from a global enforcement setting).
  if (clamped.enforcementMode !== undefined) {
    if (clamped.enforcementMode === "enforce" || trusted.enforcementMode === "enforce") {
      delete clamped.enforcementMode
    }
  }

  // riskPolicy: project can narrow allow cells and harden failure knobs, never
  // relax a trusted deny or widen an allow cell. Partial project objects must
  // not wipe trusted onInvalidDecision/onReviewerFailure back to defaults.
  if (typeof clamped.riskPolicy === "object" && clamped.riskPolicy !== null) {
    const trustedPolicy =
      typeof trusted.riskPolicy === "object" && trusted.riskPolicy !== null
        ? (trusted.riskPolicy as Record<string, unknown>)
        : (DEFAULT_RISK_POLICY as unknown as Record<string, unknown>)
    clamped.riskPolicy = clampRiskPolicy(
      clamped.riskPolicy as Record<string, unknown>,
      trustedPolicy,
    )
  }

  // escalationMode: project can only harden manual → deny, never relax deny →
  // manual. Invalid values are dropped so they cannot override a trusted deny
  // through resolveConfig's "anything but deny → manual" fallback.
  if (clamped.escalationMode !== undefined) {
    if (clamped.escalationMode !== "manual" && clamped.escalationMode !== "deny") {
      delete clamped.escalationMode
    } else if (clamped.escalationMode === "manual" && trusted.escalationMode === "deny") {
      delete clamped.escalationMode
    }
  }

  // policyRules: the project layer ADDS rules (which can only tighten — its
  // allow rules are filtered by the engine), it never erases trusted
  // global/inline deny/manual rules. Combine instead of replace so a repo
  // cannot weaken policy by declaring an empty or narrower rule set. Project
  // rules are also re-tagged source:"project" so they cannot spoof
  // source:"inline" to bypass the project-allow filter.
  if (Array.isArray(clamped.policyRules)) {
    const projectRules = (clamped.policyRules as Array<Record<string, unknown>>).map((rule) => ({
      ...rule,
      source: "project" as PolicyRule["source"],
    }))
    const trustedRules = Array.isArray(trusted.policyRules) ? trusted.policyRules : []
    clamped.policyRules = [...trustedRules, ...projectRules]
  } else if (Array.isArray(trusted.policyRules)) {
    // Project omitted policyRules entirely: preserve the trusted rules.
    clamped.policyRules = trusted.policyRules
  }

  return { ...trusted, ...clamped }
}

/** Ensure project riskPolicy can only tighten the trusted baseline. */
function clampRiskPolicy(
  project: Record<string, unknown>,
  trusted: Record<string, unknown>,
): Record<string, unknown> {
  const projectAllow =
    typeof project.allow === "object" && project.allow !== null
      ? (project.allow as Record<string, unknown>)
      : undefined
  const trustedAllow =
    typeof trusted.allow === "object" && trusted.allow !== null
      ? (trusted.allow as Record<string, unknown>)
      : {}
  const clampedAllow: Record<string, unknown> = {}
  for (const risk of ["low", "medium", "high", "critical"] as const) {
    const trustedCell = Array.isArray(trustedAllow[risk]) ? (trustedAllow[risk] as unknown[]) : []
    if (projectAllow === undefined) {
      // Project omitted allow entirely: keep the trusted cells.
      clampedAllow[risk] = trustedCell
      continue
    }
    const projectCell = Array.isArray(projectAllow[risk]) ? (projectAllow[risk] as unknown[]) : []
    // Intersection: project can only remove, never add. Missing project cell →
    // empty intersection (most restrictive) when the project provided an allow
    // object at all.
    clampedAllow[risk] = trustedCell.filter((auth) => projectCell.includes(auth))
  }

  // Start from trusted so partial project objects cannot wipe failure knobs.
  const out: Record<string, unknown> = {
    ...trusted,
    allow: clampedAllow,
  }

  // Failure knobs: project may harden manual → deny only.
  if (project.onInvalidDecision === "deny" || trusted.onInvalidDecision === "deny") {
    out.onInvalidDecision = "deny"
  } else if (project.onInvalidDecision === "manual" || project.onInvalidDecision === undefined) {
    out.onInvalidDecision = trusted.onInvalidDecision ?? "manual"
  }

  if (project.onReviewerFailure === "deny" || trusted.onReviewerFailure === "deny") {
    out.onReviewerFailure = "deny"
  } else if (project.onReviewerFailure === "manual" || project.onReviewerFailure === undefined) {
    out.onReviewerFailure = trusted.onReviewerFailure ?? "manual"
  }

  // minimumConfidence: project can raise but not lower.
  const trustedMin =
    typeof trusted.minimumConfidence === "number" && Number.isFinite(trusted.minimumConfidence)
      ? trusted.minimumConfidence
      : DEFAULT_RISK_POLICY.minimumConfidence
  if (typeof project.minimumConfidence === "number" && Number.isFinite(project.minimumConfidence)) {
    out.minimumConfidence = Math.max(trustedMin, project.minimumConfidence)
  } else {
    out.minimumConfidence = trustedMin
  }

  return out
}
