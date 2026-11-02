import type { Theme } from "@earendil-works/pi-coding-agent"

export const testReviewTheme = {
  appearance: "dark",
  fg: (_color: string, text: string) => text,
  style: (text: string) => text,
} as unknown as Theme

export function widgetLines(content: unknown): string[] | undefined {
  if (content === undefined) return undefined
  if (Array.isArray(content)) return content as string[]
  if (typeof content === "function")
    return content(undefined, testReviewTheme).render(120) as string[]
  throw new Error("Unexpected widget content")
}
