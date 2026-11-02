export interface PiReviewUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  reasoning?: number
  attempts: number
  reportedAttempts: number
}

/** Aggregate provider-reported counts; reasoning is already included in output. */
export class ReviewUsage {
  private readonly counts: PiReviewUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    attempts: 0,
    reportedAttempts: 0,
  }
  startAttempt(): void {
    this.counts.attempts++
  }
  add(value: unknown): void {
    if (!value || typeof value !== "object") return
    const usage = value as Record<string, unknown>
    const keys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const
    if (
      !keys.every(
        (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0,
      )
    )
      return
    for (const key of keys) this.counts[key] += usage[key] as number
    if (
      typeof usage.reasoning === "number" &&
      Number.isFinite(usage.reasoning) &&
      usage.reasoning >= 0
    )
      this.counts.reasoning = (this.counts.reasoning ?? 0) + usage.reasoning
    this.counts.reportedAttempts++
  }
  snapshot(): PiReviewUsage {
    return { ...this.counts }
  }
}

export function formatReviewUsage(usage: PiReviewUsage | undefined): string {
  if (!usage) return "tokens: unavailable"
  if (!usage.attempts) return "tokens: 0 (no model call)"
  if (!usage.reportedAttempts) return "tokens: unavailable (provider did not report usage)"
  const details = [`${usage.input} in`, `${usage.output} out`]
  if (usage.cacheRead) details.push(`${usage.cacheRead} cache read`)
  if (usage.cacheWrite) details.push(`${usage.cacheWrite} cache write`)
  if (usage.reasoning !== undefined)
    details.push(`${usage.reasoning} reasoning, included in output`)
  const partial = usage.reportedAttempts < usage.attempts ? "; partial usage" : ""
  return `tokens: ${usage.totalTokens} total (${details.join(" / ")})${usage.attempts > 1 ? ` across ${usage.attempts} attempts` : ""}${partial}`
}
