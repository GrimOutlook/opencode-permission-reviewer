import { expect, test } from "bun:test"
import { reviewerReasoning } from "../src/pi/reasoning.ts"

test("reviewer variants map to Pi provider-neutral thinking controls", () => {
  for (const variant of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    expect(reviewerReasoning(variant, { reasoning: true })).toEqual({ reasoning: variant })
    expect(reviewerReasoning(variant, { reasoning: false })).toEqual({})
  }
  expect(reviewerReasoning("none", { reasoning: true })).toEqual({})
  expect(reviewerReasoning("off", { reasoning: true })).toEqual({})
  expect(() => reviewerReasoning("turbo", { reasoning: true })).toThrow(
    "Unsupported Pi reviewer variant",
  )
})
