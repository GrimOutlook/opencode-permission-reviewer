import { describe, expect, test } from "bun:test"
import {
  effectiveCommands,
  lexSegments,
  SHELL_LEXER_LIMITS,
  ShellLexerLimitError,
  shellBasename,
} from "../src/shell-lexer.ts"

function values(tokens: { value: string }[]): string[] {
  return tokens.map((t) => t.value)
}

function firstExecutables(command: string): string[][] {
  const result: string[][] = []
  for (const segment of lexSegments(command)) {
    for (const effective of effectiveCommands(segment)) result.push(values(effective))
  }
  return result
}

describe("shell lexer", () => {
  test("splits on logical separators but not inside quotes", () => {
    expect(firstExecutables("a; b & c | d")).toEqual([["a"], ["b"], ["c"], ["d"]])
    expect(firstExecutables('printf "a; sudo rm -rf /"')).toEqual([["printf", "a; sudo rm -rf /"]])
    expect(firstExecutables('echo "a && b"')).toEqual([["echo", "a && b"]])
  })

  test("strips line comments only when they begin a token", () => {
    expect(firstExecutables("# sudo rm -rf /\nls")).toEqual([["ls"]])
    expect(firstExecutables("echo a#b")).toEqual([["echo", "a#b"]])
  })

  test("peels privilege wrappers and their value-taking options", () => {
    expect(firstExecutables("sudo rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("sudo -u root rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("sudo -uroot rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("env VAR=1 rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("nice -n 5 rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("stdbuf -oL rm -rf /")).toEqual([["rm", "-rf", "/"]])
  })

  test("peels nested wrappers and env-style assignments together", () => {
    expect(firstExecutables("sudo env VAR=1 rm -rf /")).toEqual([["rm", "-rf", "/"]])
  })

  test("resolves absolute binary paths via basename", () => {
    expect(firstExecutables("/bin/rm -rf /")).toEqual([["/bin/rm", "-rf", "/"]])
    expect(firstExecutables("/usr/bin/rm -rf /")).toEqual([["/usr/bin/rm", "-rf", "/"]])
    expect(shellBasename("/usr/bin/env")).toBe("env")
    expect(shellBasename("/bin/rm")).toBe("rm")
  })

  test("destructures command-string forms", () => {
    expect(firstExecutables("sh -c 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("sudo bash -c 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("su -c 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("env -S 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("bash -ic 'rm -rf /'")).toEqual([["rm", "-rf", "/"]])
  })

  test("destructures ssh, busybox and chroot", () => {
    expect(firstExecutables("ssh host rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("ssh -i /key user@host rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("busybox rm -rf /")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("chroot /rootdir rm -rf /")).toEqual([["rm", "-rf", "/"]])
  })

  test("skips shell keywords at position 0", () => {
    expect(firstExecutables("{ rm -rf /; }")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("(rm -rf /)")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("if true; then rm -rf /; fi")).toEqual([
      ["if", "true"],
      ["rm", "-rf", "/"],
      ["fi"],
    ])
  })

  test("leaves plain executables untouched", () => {
    expect(firstExecutables("grep -r foo .")).toEqual([["grep", "-r", "foo", "."]])
    expect(firstExecutables("echo hello")).toEqual([["echo", "hello"]])
  })
})

describe("shell lexer resource bounds", () => {
  test("rejects oversized input instead of lexing it", () => {
    const oversized = "echo " + "a".repeat(SHELL_LEXER_LIMITS.maxInputChars)
    expect(() => lexSegments(oversized)).toThrow(ShellLexerLimitError)
    // Just under the limit still lexes normally.
    expect(() => lexSegments("echo ok")).not.toThrow()
  })

  test("rejects token floods", () => {
    const flood = new Array(SHELL_LEXER_LIMITS.maxTokens + 2).fill("a").join(" ")
    expect(() => lexSegments(flood)).toThrow(ShellLexerLimitError)
  })

  test("bounds deeply nested env -S recursion", () => {
    // Previously this recursed through walk() without any depth or size budget:
    // ~3k nestings took seconds and ~10k exhausted the process heap.
    const nested = "env -S ".repeat(10_000) + "rm -rf /"
    const start = Date.now()
    expect(() => {
      for (const segment of lexSegments(nested)) effectiveCommands(segment)
    }).toThrow(ShellLexerLimitError)
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  test("bounds deeply nested wrapper recursion", () => {
    // Each `busybox` applet peel recurses one level deeper.
    const nested = "busybox ".repeat(SHELL_LEXER_LIMITS.maxDepth + 5) + "rm -rf /"
    expect(() => {
      for (const segment of lexSegments(nested)) effectiveCommands(segment)
    }).toThrow(ShellLexerLimitError)
  })

  test("leaves ordinary nesting well within budget", () => {
    expect(firstExecutables("env -S 'sudo rm -rf /'")).toEqual([["rm", "-rf", "/"]])
    expect(firstExecutables("busybox busybox rm -rf /")).toEqual([["rm", "-rf", "/"]])
  })
})
