import type { Theme } from "@earendil-works/pi-coding-agent"
import { Text, rgbColor } from "@earendil-works/pi-tui"

/** Full-width gray background, including padding and wrapped lines. */
export function grayReviewPanel(text: string, theme: Theme): Text {
  return new Text(text, 1, 1, (line) => {
    const shade = theme.appearance === "light" ? 229 : 48
    return theme.style(line, { bg: rgbColor(shade, shade, shade) })
  })
}
