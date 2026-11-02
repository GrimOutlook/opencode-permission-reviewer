import { expect, test } from "bun:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { styleText, visibleWidth, type Color } from "@earendil-works/pi-tui"
import { grayReviewPanel } from "../src/pi/panel.ts"

test("review panels paint full-width gray padding and wrapped lines in light/dark themes", () => {
  for (const [appearance, shade] of [
    ["dark", 48],
    ["light", 229],
  ] as const) {
    const theme = {
      appearance,
      style: (text: string, options: { bg: Color }) => styleText(text, options, "truecolor"),
    } as unknown as Theme
    const panel = grayReviewPanel("A long review result that wraps across the narrow panel", theme)
    for (const line of panel.render(20)) {
      expect(line).toContain(`\u001b[48;2;${shade};${shade};${shade}m`)
      expect(visibleWidth(line)).toBe(20)
    }
  }
})
