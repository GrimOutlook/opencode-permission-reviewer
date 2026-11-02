type ReviewerThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/** Use Pi's provider-neutral stream path so it can translate/clamp per provider. */
export function reviewerReasoning(
  variant: string,
  model: { reasoning: boolean },
): { reasoning?: ReviewerThinkingLevel } {
  if (variant === "none" || variant === "off") return {}
  if (
    variant !== "minimal" &&
    variant !== "low" &&
    variant !== "medium" &&
    variant !== "high" &&
    variant !== "xhigh" &&
    variant !== "max"
  ) {
    throw new Error(
      `Unsupported Pi reviewer variant: ${variant}. Use off, none, minimal, low, medium, high, xhigh, or max.`,
    )
  }
  return model.reasoning ? { reasoning: variant } : {}
}
