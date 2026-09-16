import { createHash } from "node:crypto"
import type { HeredocRecord } from "../types.ts"

/*
 * Heredoc extraction.
 *
 * Runs BEFORE the shell lexer used by the capability analyzer, so heredoc
 * bodies never become tokens the analyzer walks. The motivating case is:
 *
 *   cat > /tmp/x <<'EOF'
 *   ...arbitrary content...
 *   EOF
 *   bun /tmp/x
 *
 * The extractor returns the command with each heredoc body replaced by a
 * redacted placeholder, plus structured records (delimiter, expansion flag,
 * bounded+redacted body, sha256 of the full body, output target when a `> path`
 * precedes the heredoc, dynamic flag).
 *
 * NOTE: this protects the capability analyzer and evidence providers only.
 * The emergency brake operates on the RAW command independently and does NOT
 * use this extractor — heredoc bodies may still appear as tokens the brake
 * sees. This is a known conservative limitation (the brake may false-positive
 * on destructive text inside a heredoc body, but never false-negative).
 *
 * This is a bounded static parser, not a shell executor: it never expands the
 * body, never runs anything, and marks bodies with unresolvable expansions as
 * dynamic (partial analysis).
 */

/** Maximum body bytes retained (bounded + redacted for prompt/audit safety). */
const MAX_BODY_BYTES = 4096

/**
 * Characters that terminate an unquoted word in Bash. The heredoc delimiter is
 * an ordinary word, so it ends at whitespace or at a shell metacharacter.
 */
const WORD_TERMINATORS = new Set([" ", "\t", "\n", "\r", ";", "&", "|", "<", ">", "(", ")"])

interface HeredocStart {
  /** Index of the `<<` operator in the source. */
  index: number
  /** Index just past the delimiter word. */
  end: number
  operator: "<<" | "<<-"
  /** Delimiter after quote and backslash removal — what closes the body. */
  delimiter: string
  /** Delimiter exactly as written, used to rebuild the sanitized command. */
  raw: string
  /** Any quoting or escaping in the word disables expansion in the body. */
  expansionDisabled: boolean
}

/**
 * Read a heredoc delimiter word the way Bash does.
 *
 * The word may be unquoted (`EOF`, `1EOF`, `.py`), fully quoted (`'EOF'`,
 * `"EOF"`), partially quoted (`"E"OF`), or backslash-escaped (`\EOF`). Quote
 * removal is applied to get the delimiter that must appear on the closing
 * line, and *any* quoting or escaping anywhere in the word disables parameter
 * expansion in the body.
 */
function readDelimiterWord(
  source: string,
  start: number,
): { value: string; raw: string; end: number; quoted: boolean } | null {
  let index = start
  let value = ""
  let quoted = false
  while (index < source.length) {
    const character = source[index]!
    if (character === "\\" && index + 1 < source.length) {
      value += source[index + 1]!
      quoted = true
      index += 2
      continue
    }
    if (character === "'" || character === '"') {
      const close = source.indexOf(character, index + 1)
      // An unterminated quote is not a delimiter we can trust; leave the `<<`
      // alone rather than guessing where the body ends.
      if (close === -1) return null
      value += source.slice(index + 1, close)
      quoted = true
      index = close + 1
      continue
    }
    if (WORD_TERMINATORS.has(character)) break
    value += character
    index += 1
  }
  if (value === "") return null
  return { value, raw: source.slice(start, index), end: index, quoted }
}

/**
 * Find the next heredoc operator at or after `from`, skipping `<<` that appears
 * inside quoted text (`echo "a << b"`) and here-strings (`<<<`), neither of
 * which starts a heredoc.
 */
function findHeredocStart(source: string, from: number): HeredocStart | null {
  let quote: "'" | '"' | undefined
  let index = from
  while (index < source.length) {
    const character = source[index]!
    if (quote) {
      if (character === "\\" && quote === '"' && index + 1 < source.length) {
        index += 2
        continue
      }
      if (character === quote) quote = undefined
      index += 1
      continue
    }
    if (character === "\\") {
      index += 2
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      index += 1
      continue
    }
    if (character !== "<" || source[index + 1] !== "<") {
      index += 1
      continue
    }
    // `<<<` is a here-string, not a heredoc.
    if (source[index + 2] === "<") {
      index += 3
      continue
    }
    let cursor = index + 2
    let operator: "<<" | "<<-" = "<<"
    if (source[cursor] === "-") {
      operator = "<<-"
      cursor += 1
    }
    while (source[cursor] === " " || source[cursor] === "\t") cursor += 1
    const word = readDelimiterWord(source, cursor)
    if (word === null) {
      index += 2
      continue
    }
    return {
      index,
      end: word.end,
      operator,
      delimiter: word.value,
      raw: word.raw,
      expansionDisabled: word.quoted,
    }
  }
  return null
}

/** Result of extracting heredocs from a raw command. */
export interface HeredocExtraction {
  /** Command with heredoc bodies replaced by placeholder tokens. */
  sanitizedCommand: string
  /** Structured heredoc records. */
  heredocs: HeredocRecord[]
  /** Whether any dynamic construct was detected inside a body. */
  hasDynamicConstructs: boolean
}

/**
 * Extract every heredoc in `command`, replacing each body with a placeholder
 * `<HEREDOC:sha256:xxxxxxxx>` so the downstream lexer never sees the content.
 */
export function extractHeredocs(command: string): HeredocExtraction {
  const heredocs: HeredocRecord[] = []
  let hasDynamicConstructs = false
  let out = ""
  let cursor = 0

  while (cursor <= command.length) {
    const start = findHeredocStart(command, cursor)
    if (start === null) break

    const matchStart = start.index
    const { operator, delimiter, expansionDisabled } = start

    // Emit the text before the heredoc operator unchanged.
    out += command.slice(cursor, matchStart)

    // Find the line terminator that ends the heredoc-start line.
    let lineEnd = start.end
    while (lineEnd < command.length && command[lineEnd] !== "\n") lineEnd += 1

    // The rest of the start line (a redirection, a pipe, a second heredoc
    // operator) is real command text and must survive into the sanitized
    // command; only the *body* is replaced.
    const restOfLine = command.slice(start.end, lineEnd)

    // A pending output redirection on the same line, before the operator
    // (`cat > /tmp/x <<'EOF'`) or after it (`cat <<'EOF' > /tmp/x`).
    const outputTarget =
      findOutputTarget(command.slice(cursor, matchStart)) ?? findOutputTarget(restOfLine)

    // Collect the body until a line holding only the delimiter (after optional
    // leading tabs for `<<-`).
    const bodyStart = Math.min(lineEnd + 1, command.length)
    const { body, endIndex, truncated } = collectBody(
      command,
      bodyStart,
      delimiter,
      operator === "<<-",
    )

    const fullBody = body
    const sha256 = createHash("sha256").update(fullBody).digest("hex")
    const { bounded, wasTruncated } = boundBody(fullBody, truncated)
    if (containsDynamic(fullBody, expansionDisabled)) hasDynamicConstructs = true

    heredocs.push({
      delimiter,
      operator,
      expansionDisabled,
      bodyBounded: bounded,
      bodySha256: sha256,
      truncated: wasTruncated,
      ...(outputTarget === undefined ? {} : { outputTarget }),
      dynamic: containsDynamic(fullBody, expansionDisabled),
    })

    // Replace the body with a placeholder; keep the line terminator structure so
    // the lexer still splits commands on newlines correctly.
    out += `${operator}${start.raw} <HEREDOC:sha256:${sha256.slice(0, 12)}>${restOfLine}`
    cursor = endIndex
  }

  out += command.slice(cursor)
  return { sanitizedCommand: out, heredocs, hasDynamicConstructs }
}

/** Scan the text before a heredoc operator for a trailing `> path` target. */
function findOutputTarget(beforeOperator: string): string | undefined {
  // Match the last `>` / `>>` redirection target on the start line.
  const trimmed = beforeOperator.replace(/\s+$/, "")
  const match = />>?\s*([^\s|;&<>]+)\s*$/.exec(trimmed)
  return match === null ? undefined : stripQuotes(match[1]!)
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const head = token[0]
    const tail = token[token.length - 1]
    if ((head === "'" || head === '"') && head === tail) return token.slice(1, -1)
  }
  return token
}

/** Collect the heredoc body until the delimiter line. Returns the body text and
 *  the index just past the closing delimiter line. */
function collectBody(
  source: string,
  start: number,
  delimiter: string,
  tabStripped: boolean,
): { body: string; endIndex: number; truncated: boolean } {
  let i = start
  let body = ""
  let truncated = false
  while (i < source.length) {
    let lineEnd = source.indexOf("\n", i)
    if (lineEnd === -1) lineEnd = source.length
    const line = source.slice(i, lineEnd)
    const candidate = tabStripped ? line.replace(/^\t+/, "") : line
    if (candidate === delimiter) {
      // Preserve the trailing newline in the stream so the lexer still splits
      // the command that follows the heredoc into its own segment.
      return { body, endIndex: lineEnd, truncated }
    }
    body += line + "\n"
    if (body.length > MAX_BODY_BYTES * 4) truncated = true
    i = lineEnd + 1
  }
  // Unterminated heredoc: treat the remainder as the body (partial).
  truncated = true
  return { body, endIndex: source.length, truncated }
}

function boundBody(
  fullBody: string,
  alreadyTruncated: boolean,
): { bounded: string; wasTruncated: boolean } {
  const bytes = Buffer.byteLength(fullBody, "utf8")
  if (bytes <= MAX_BODY_BYTES) return { bounded: fullBody, wasTruncated: alreadyTruncated }
  // Truncate by character count as a conservative approximation.
  let cut = 0
  let len = 0
  while (cut < fullBody.length && len < MAX_BODY_BYTES) {
    len += Buffer.byteLength(fullBody[cut]!, "utf8")
    cut += 1
  }
  return { bounded: fullBody.slice(0, cut) + "\n…[truncated]", wasTruncated: true }
}

/** Whether the body contains constructs that prevent static analysis. */
function containsDynamic(body: string, expansionDisabled: boolean): boolean {
  if (expansionDisabled) return false
  // With expansion enabled, `$VAR`, `$(...)`, and backticks are unresolvable.
  return /\$\(?|`/.test(body)
}
