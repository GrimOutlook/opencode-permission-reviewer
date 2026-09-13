/*
 * Minimal shell-aware tokenizer used by the deterministic emergency brake.
 *
 * This is NOT a full shell interpreter. It performs just enough static
 * analysis to evaluate the *real* executable of a command:
 *   - grouping of single/double quotes (so separators inside quotes do not
 *     split a token, and `printf "a; sudo rm -rf /"` stays one argument),
 *   - splitting on logical command separators (`;`, `|`, `&`, newlines),
 *   - stripping `#` comments when they begin a token,
 *   - a recursive "effective command" resolver that peels privilege wrappers
 *     (`sudo`, `doas`, `env`, `command`, `nice`, `nohup`, `time`, `stdbuf`,
 *     `ionice`, `pkexec`, `fakeroot`, `setsid`, `setpriv`, `unshare`, `run0`)
 *     and destructures command-string forms (`sh -c`, `su -c`, `env -S`,
 *     `ssh host cmd`, `busybox applet`, `chroot root cmd`).
 *
 * It deliberately does NOT expand variables, globs, command substitutions,
 * heredocs, or arithmetic. Those remain the model reviewer's job; the brake
 * is only a last line of defense for *unmistakable* literal destruction.
 *
 * Because the resolver re-lexes command strings (`sh -c`, `env -S`, …) it is
 * mutually recursive with the tokenizer, and a crafted command can nest those
 * forms arbitrarily deep. Every entry point is therefore bounded by
 * `SHELL_LEXER_LIMITS` and throws `ShellLexerLimitError` when a budget is
 * exhausted, so callers can decide how to fail. The emergency brake fails
 * *closed* on that error (see emergency-brake.ts).
 */

export interface ShellToken {
  /** Original text including any surrounding quotes. */
  raw: string
  /** Unquoted/normalized value used for comparisons. */
  value: string
}

export interface ShellSegment {
  tokens: ShellToken[]
}

/**
 * Static analysis budgets. These are far above any legitimate command an agent
 * would ask to run, and exist only so that adversarial input cannot turn the
 * tokenizer/resolver pair into an unbounded memory or CPU sink.
 */
export const SHELL_LEXER_LIMITS = {
  /** Longest command accepted for lexing, in characters. */
  maxInputChars: 64 * 1024,
  /** Most tokens a single `lexSegments` call may produce. */
  maxTokens: 20_000,
  /** Deepest wrapper/command-string nesting the resolver will follow. */
  maxDepth: 32,
  /** Total characters the resolver may re-lex across all nested expansions. */
  maxExpandedChars: 256 * 1024,
  /** Most effective commands a single segment may resolve to. */
  maxEffectiveCommands: 4_096,
} as const

/** Thrown when a `SHELL_LEXER_LIMITS` budget is exhausted. */
export class ShellLexerLimitError extends Error {
  constructor(readonly limit: keyof typeof SHELL_LEXER_LIMITS) {
    super(`shell lexer limit exceeded: ${limit}`)
    this.name = "ShellLexerLimitError"
  }
}

const SEPARATORS = new Set([";", "|", "&", "\n", "\r", "(", ")"])
const WHITESPACE = new Set([" ", "\t"])

const TRANSPARENT_WRAPPERS = new Set([
  "sudo",
  "doas",
  "pkexec",
  "env",
  "command",
  "nice",
  "nohup",
  "time",
  "stdbuf",
  "ionice",
  "fakeroot",
  "setsid",
  "setpriv",
  "unshare",
  "run0",
  // Exec wrappers that run their operand as a command. They are as transparent
  // as `sudo` for the brake's purposes: whatever follows the wrapper's own
  // options is the real executable.
  "timeout",
  "xargs",
  "strace",
  "ltrace",
  "systemd-run",
  "nsenter",
  "firejail",
  "proxychains",
  "proxychains4",
  "torsocks",
  "eatmydata",
  "catchsegv",
  "chrt",
  "taskset",
  "flock",
  "script",
  "watch",
])

/**
 * Wrappers that take a positional operand of their own before the command
 * (`timeout 10 cmd`, `chrt 99 cmd`, `flock /tmp/lock cmd`). The pattern
 * recognizes that operand so a value-carrying option form
 * (`taskset -c 0-3 cmd`) does not cause the executable itself to be skipped;
 * `null` means the operand is unconstrained and always consumed.
 */
const POSITIONAL_WRAPPERS: Record<string, RegExp | null> = {
  timeout: /^[0-9]+(?:\.[0-9]+)?[smhd]?$/,
  chrt: /^[0-9]+$/,
  taskset: /^(?:0x[0-9a-fA-F]+|[0-9]+(?:[,-][0-9]+)*)$/,
  flock: null,
}

/**
 * Wrapper short options that consume the next token as their value. Only flags
 * documented to take an argument are listed; pure flags (sudo -S/-A, unshare
 * --mount/--pid/…, run0 --mkdir/--no-ask-password) are intentionally absent so
 * the real executable that follows them is not swallowed by mistake.
 */
const VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "-p", "-R", "-T", "-U", "-D", "-r", "-t"]),
  doas: new Set(["-u", "--user", "-a"]),
  pkexec: new Set(["--user", "--session"]),
  env: new Set(["-u", "--unset", "-S", "-C"]),
  nice: new Set(["-n", "--adjustment"]),
  time: new Set(["-o", "--output", "-f"]),
  ionice: new Set(["-c", "-n"]),
  setpriv: new Set([
    "--reuid",
    "--regid",
    "--inh-caps",
    "--bounding-set",
    "--ambient-caps",
    "--clear-groups",
  ]),
  command: new Set(),
  nohup: new Set(),
  stdbuf: new Set(),
  fakeroot: new Set(),
  setsid: new Set(),
  unshare: new Set(),
  run0: new Set(["--unit", "--service", "--slice", "--setenv", "--chdir"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  xargs: new Set([
    "-I",
    "-i",
    "-L",
    "-n",
    "-P",
    "-s",
    "-E",
    "-e",
    "-d",
    "-a",
    "--arg-file",
    "--delimiter",
    "--eof",
    "--max-args",
    "--max-chars",
    "--max-lines",
    "--max-procs",
    "--replace",
  ]),
  strace: new Set(["-o", "-e", "-p", "-s", "-E", "-u", "-b", "-a", "-P", "-I", "-O", "-S"]),
  ltrace: new Set(["-o", "-e", "-p", "-s", "-u", "-a", "-l", "-n", "-X"]),
  "systemd-run": new Set([
    "-p",
    "--property",
    "-u",
    "--unit",
    "--description",
    "--slice",
    "-E",
    "--setenv",
    "--uid",
    "--gid",
    "--nice",
    "-M",
    "--machine",
    "--on-active",
    "--on-boot",
    "--on-calendar",
    "--timer-property",
    "--service-type",
    "--working-directory",
  ]),
  nsenter: new Set(["-t", "--target", "-S", "--setuid", "-G", "--setgid", "--wd"]),
  firejail: new Set(),
  proxychains: new Set(["-f"]),
  proxychains4: new Set(["-f"]),
  torsocks: new Set(),
  eatmydata: new Set(),
  catchsegv: new Set(),
  chrt: new Set(["-p", "--pid"]),
  taskset: new Set(["-c", "--cpu-list", "-p", "--pid"]),
  flock: new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]),
  script: new Set(["-c", "--command", "-f", "--log-out", "-I", "-B", "-O", "-T", "-m", "-l"]),
  watch: new Set(["-n", "--interval", "-d", "--differences"]),
}

const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"])
const SU_BINARIES = new Set(["su", "runuser", "super"])
/**
 * Binaries whose `-c`/`--command` argument is a command string to recurse into.
 * `script -c "rm -rf /" /dev/null` and `flock /tmp/l -c "rm -rf /"` reach the
 * real executable this way rather than through a positional operand.
 */
const COMMAND_STRING_BINARIES = new Set([
  ...SHELL_BINARIES,
  ...SU_BINARIES,
  "script",
  "flock",
  "watch",
])
const SSH_VALUE_OPTIONS = new Set([
  "-i",
  "-l",
  "-p",
  "-o",
  "-F",
  "-J",
  "-b",
  "-c",
  "-e",
  "-m",
  "-w",
  "-W",
  "-D",
  "-L",
  "-R",
  "-I",
  "-Q",
  "-O",
  "-E",
])
const SHELL_KEYWORDS = new Set(["{", "}", "(", ")", "then", "else", "do", "elif", "!"])

function basename(exe: string): string {
  const slash = exe.lastIndexOf("/")
  return slash >= 0 ? exe.slice(slash + 1) : exe
}

/**
 * Tokenize `command` into logical segments (one per sub-command separated by
 * `;`, `|`, `&`, or newline) with quote-aware, comment-aware grouping.
 */
export function lexSegments(command: string): ShellSegment[] {
  if (command.length > SHELL_LEXER_LIMITS.maxInputChars) {
    throw new ShellLexerLimitError("maxInputChars")
  }
  const segments: ShellSegment[] = []
  let tokenCount = 0
  let tokens: ShellToken[] = []
  let value = ""
  let raw = ""
  let hasToken = false
  let inSingle = false
  let inDouble = false

  const flushToken = () => {
    if (hasToken) {
      tokenCount += 1
      if (tokenCount > SHELL_LEXER_LIMITS.maxTokens) {
        throw new ShellLexerLimitError("maxTokens")
      }
      tokens.push({ raw, value })
      value = ""
      raw = ""
      hasToken = false
    }
  }
  const flushSegment = () => {
    flushToken()
    if (tokens.length > 0) {
      segments.push({ tokens })
      tokens = []
    }
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]!
    if (inSingle) {
      raw += c
      if (c === "'") inSingle = false
      else value += c
      i += 1
      continue
    }
    if (inDouble) {
      raw += c
      if (c === '"') {
        inDouble = false
      } else if (c === "\\" && i + 1 < command.length) {
        const next = command[i + 1]!
        raw += next
        if ('$`"\\n'.includes(next)) {
          value += next === "n" ? "\n" : next
          i += 2
          continue
        }
        value += "\\"
        i += 1
        continue
      } else {
        value += c
      }
      i += 1
      continue
    }
    if (c === "'") {
      inSingle = true
      raw += c
      hasToken = true
      i += 1
      continue
    }
    if (c === '"') {
      inDouble = true
      raw += c
      hasToken = true
      i += 1
      continue
    }
    if (SEPARATORS.has(c)) {
      flushSegment()
      i += 1
      continue
    }
    if (WHITESPACE.has(c)) {
      flushToken()
      i += 1
      continue
    }
    if (c === "#" && !hasToken) {
      // Line comment: consume until newline (newline itself closes the segment).
      while (i < command.length && command[i] !== "\n") i += 1
      continue
    }
    if (c === "\\" && i + 1 < command.length) {
      const next = command[i + 1]!
      raw += "\\" + next
      value += next
      hasToken = true
      i += 2
      continue
    }
    value += c
    raw += c
    hasToken = true
    i += 1
  }
  flushSegment()
  return segments
}

/**
 * Resolve a segment into its "effective commands" — the token lists starting
 * at each real executable, after peeling wrappers and destructuring
 * command-string forms. May yield multiple commands when a shell/su `-c` body
 * itself contains separators.
 */
export function effectiveCommands(segment: ShellSegment): ShellToken[][] {
  const out: ShellToken[][] = []
  walk(segment.tokens, out, 0, { expandedChars: 0 })
  return out
}

/**
 * Budget shared by one `effectiveCommands` traversal. `expandedChars` totals
 * the text re-lexed across *every* nested command string, so neither deep
 * nesting nor wide fan-out can amplify the work without limit. Depth is passed
 * separately because it is per-branch, not cumulative.
 */
interface WalkBudget {
  expandedChars: number
}

/** Re-lex a nested command string, charging the traversal budget first. */
function expand(script: string, out: ShellToken[][], depth: number, budget: WalkBudget): void {
  budget.expandedChars += script.length
  if (budget.expandedChars > SHELL_LEXER_LIMITS.maxExpandedChars) {
    throw new ShellLexerLimitError("maxExpandedChars")
  }
  for (const sub of lexSegments(script)) walk(sub.tokens, out, depth + 1, budget)
}

function walk(tokens: ShellToken[], out: ShellToken[][], depth: number, budget: WalkBudget): void {
  if (depth > SHELL_LEXER_LIMITS.maxDepth) {
    throw new ShellLexerLimitError("maxDepth")
  }
  if (out.length > SHELL_LEXER_LIMITS.maxEffectiveCommands) {
    throw new ShellLexerLimitError("maxEffectiveCommands")
  }
  let i = 0
  while (i < tokens.length && SHELL_KEYWORDS.has(tokens[i]!.value)) i += 1

  // Consume leading VAR=value assignments (env-style, only at the head).
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!.value)) i += 1

  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok.value === "--") {
      break
    }
    const base = basename(tok.value)
    if (base === "env") {
      // `env -S 'command string'` (or unquoted: `env -S cmd args…`) carries a
      // parsed command line, and any operands after the string are appended to
      // it. Recurse into the concatenation so `env -S rm -rf /` is caught.
      const sIndex = findOptionIndex(tokens, i + 1, "-S")
      if (sIndex !== -1 && sIndex + 1 < tokens.length) {
        const script = tokens[sIndex + 1]!.value
        const tail = tokens
          .slice(sIndex + 2)
          .map((t) => t.value)
          .join(" ")
        expand(tail ? `${script} ${tail}` : script, out, depth, budget)
        return
      }
    }
    if (COMMAND_STRING_BINARIES.has(base)) {
      const script = findCommandString(tokens, i + 1)
      if (script !== null) {
        expand(script, out, depth, budget)
        return
      }
    }
    if (TRANSPARENT_WRAPPERS.has(base)) {
      const valueOpts = VALUE_OPTIONS[base] ?? new Set<string>()
      const positionalPattern = POSITIONAL_WRAPPERS[base] ?? null
      let positionalPending = base in POSITIONAL_WRAPPERS
      let endOfFlags = false
      i += 1
      while (i < tokens.length) {
        const opt = tokens[i]!.value
        if (!endOfFlags && opt === "--") {
          endOfFlags = true
          i += 1
          continue
        }
        // Env-style VAR=value arguments that follow a wrapper (e.g. `env FOO=bar …`).
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) {
          i += 1
          continue
        }
        if (!endOfFlags && opt.startsWith("-") && opt.length > 1) {
          i += consumesNextToken(opt, valueOpts) ? 2 : 1
          continue
        }
        // The wrapper's own positional operand (`timeout 10 …`, `flock file …`).
        if (positionalPending && (positionalPattern === null || positionalPattern.test(opt))) {
          positionalPending = false
          i += 1
          continue
        }
        break
      }
      continue
    }
    if (base === "ssh") {
      const rest = consumeSshRemote(tokens, i + 1)
      if (rest.length > 0) {
        expand(rest.map((t) => t.value).join(" "), out, depth, budget)
      }
      return
    }
    if (base === "busybox") {
      if (i + 1 < tokens.length) walk(tokens.slice(i + 1), out, depth + 1, budget)
      return
    }
    if (base === "chroot") {
      // chroot [OPTION]... NEWROOT [COMMAND [ARG]...]: skip options, then the
      // NEWROOT token, then recurse into the real command tail.
      let j = i + 1
      while (j < tokens.length) {
        const opt = tokens[j]!.value
        if (opt === "--") {
          j += 1
          break
        }
        if (opt.startsWith("-") && opt.length > 1) {
          j += 1
          continue
        }
        break
      }
      if (j + 1 < tokens.length) walk(tokens.slice(j + 1), out, depth + 1, budget)
      return
    }
    out.push(tokens.slice(i))
    return
  }
}

/**
 * Whether an option token makes the wrapper consume the *next* token as its
 * value. Long options are matched directly; a short cluster behaves like the
 * letters spelled out separately (`-Hu root` == `-H -u root`), and a
 * value-taking letter that is not last takes the rest of the cluster as its
 * value instead (`-uroot`).
 */
function consumesNextToken(opt: string, valueOpts: Set<string>): boolean {
  if (opt.startsWith("--")) return valueOpts.has(opt)
  for (let k = 1; k < opt.length; k += 1) {
    if (!valueOpts.has(`-${opt[k]}`)) continue
    return k === opt.length - 1
  }
  return false
}

/** Find a `-c`/`--command` command-string argument and return its (unquoted) value. */
function findCommandString(tokens: ShellToken[], start: number): string | null {
  let i = start
  let endOfFlags = false
  while (i < tokens.length) {
    const t = tokens[i]!.value
    if (!endOfFlags && t === "--") {
      endOfFlags = true
      i += 1
      continue
    }
    if (!endOfFlags && t === "-c") {
      return i + 1 < tokens.length ? tokens[i + 1]!.value : null
    }
    // Long form: `--command` (next token) or `--command=VALUE`.
    if (!endOfFlags && t === "--command") {
      return i + 1 < tokens.length ? tokens[i + 1]!.value : null
    }
    if (!endOfFlags && t.startsWith("--command=")) {
      return t.slice("--command=".length)
    }
    // Combined short flag containing `c` (e.g. `bash -ic '...'`); value is next token.
    if (
      !endOfFlags &&
      t.startsWith("-") &&
      !t.startsWith("--") &&
      t.length > 1 &&
      t.includes("c")
    ) {
      return i + 1 < tokens.length ? tokens[i + 1]!.value : null
    }
    i += 1
  }
  return null
}

/** Find the token index of a named short option (e.g. `env -S`), or -1. */
function findOptionIndex(tokens: ShellToken[], start: number, name: string): number {
  let i = start
  let endOfFlags = false
  while (i < tokens.length) {
    const t = tokens[i]!.value
    if (!endOfFlags && t === "--") {
      endOfFlags = true
      i += 1
      continue
    }
    if (!endOfFlags && t === name) return i
    i += 1
  }
  return -1
}

/** Consume ssh options + host and return the remaining remote-command tokens. */
function consumeSshRemote(tokens: ShellToken[], start: number): ShellToken[] {
  let i = start
  let hostSeen = false
  while (i < tokens.length) {
    const t = tokens[i]!.value
    if (t === "--") {
      i += 1
      break
    }
    if (t.startsWith("-") && t.length > 1) {
      if (SSH_VALUE_OPTIONS.has(t)) i += 2
      else i += 1
      continue
    }
    if (!hostSeen) {
      hostSeen = true
      i += 1
      continue
    }
    break
  }
  return tokens.slice(i)
}

export { basename as shellBasename }
