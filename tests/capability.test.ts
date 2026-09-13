import { describe, expect, test } from "bun:test"
import { analyzeCapability } from "../src/capability/bash-analyzer.ts"
import { parseCommand } from "../src/capability/command-parser.ts"
import { extractHeredocs } from "../src/capability/heredoc-extractor.ts"
import type { CapabilityAssessment } from "../src/types.ts"

const DIR = "/home/user/project"
const WT = "/home/user/project"

function assess(command: string): CapabilityAssessment {
  return analyzeCapability(parseCommand(command), DIR, WT)
}

describe("heredoc extractor", () => {
  test("quoted delimiter disables expansion and body is replaced with a placeholder", () => {
    const cmd = "cat > /tmp/x <<'EOF'\nhello\nEOF\necho done"
    const { sanitizedCommand, heredocs } = extractHeredocs(cmd)
    expect(sanitizedCommand).not.toContain("hello")
    expect(sanitizedCommand).toContain("<HEREDOC:sha256:")
    expect(heredocs).toHaveLength(1)
    expect(heredocs[0]!.delimiter).toBe("EOF")
    expect(heredocs[0]!.expansionDisabled).toBe(true)
    expect(heredocs[0]!.outputTarget).toBe("/tmp/x")
    expect(heredocs[0]!.bodyBounded).toContain("hello")
    expect(heredocs[0]!.bodySha256).toHaveLength(64)
    expect(heredocs[0]!.dynamic).toBe(false)
  })

  test("unquoted delimiter enables expansion and is flagged dynamic", () => {
    const cmd = "cat <<EOF\n$HOME\nEOF"
    const { heredocs } = extractHeredocs(cmd)
    expect(heredocs).toHaveLength(1)
    expect(heredocs[0]!.expansionDisabled).toBe(false)
    expect(heredocs[0]!.dynamic).toBe(true)
  })

  test("unterminated heredoc is marked truncated, never throws", () => {
    const cmd = "cat <<EOF\nnever closed"
    const { heredocs } = extractHeredocs(cmd)
    expect(heredocs).toHaveLength(1)
    expect(heredocs[0]!.truncated).toBe(true)
  })

  test("tab-stripped delimiter (<<-) closes on a tab-indented line", () => {
    const cmd = "cat <<-END\n\tbody\n\tEND\n"
    const { heredocs } = extractHeredocs(cmd)
    expect(heredocs).toHaveLength(1)
    expect(heredocs[0]!.delimiter).toBe("END")
    expect(heredocs[0]!.operator).toBe("<<-")
  })

  test("multiple heredocs in one command are all extracted", () => {
    const cmd = "cat <<A\nx\nA\ncat <<B\ny\nB"
    const { heredocs } = extractHeredocs(cmd)
    expect(heredocs).toHaveLength(2)
  })
})

describe("capability analyzer — motivating heredoc + bun case", () => {
  test("cat > /tmp/x <<'EOF' ... EOF; bun /tmp/x is arbitrary code execution + temp write", () => {
    const cmd =
      "cat > /tmp/opencode/verify-brake.ts <<'EOF'\nconsole.log('pwned')\nEOF\nbun /tmp/opencode/verify-brake.ts"
    const a = assess(cmd)
    expect(a.createsAdHocCode.value).toBe(true)
    expect(a.executesCode.value).toBe(true)
    expect(a.writeEffects.temporaryWrite.value).toBe(true)
    expect(a.actionClass.value).toBe("code-execution")
    expect(a.parserCompleteness).toBe("complete-for-supported-form")
    expect(a.analysisWarnings).toHaveLength(0)
  })
})

describe("path normalization before classification", () => {
  test("relative traversal out of the workspace is external, not workspace", () => {
    const a = assess("rm -rf ../../../etc")
    expect(a.writeEffects.externalWrite.value).toBe(true)
    expect(a.writeEffects.workspaceWrite.value).toBe("unknown")
  })

  test("traversal that lands back inside the workspace stays workspace", () => {
    const a = assess("rm -rf src/../dist")
    expect(a.writeEffects.workspaceWrite.value).toBe(true)
    expect(a.writeEffects.externalWrite.value).toBe("unknown")
  })

  test("absolute traversal through a temp root is classified by its real target", () => {
    const a = assess("rm -rf /tmp/../etc/cron.d")
    expect(a.writeEffects.externalWrite.value).toBe(true)
    expect(a.writeEffects.temporaryWrite.value).toBe("unknown")
  })

  test("copying out of the workspace through traversal is an external write", () => {
    const a = assess(`cp ${DIR}/secret ../../outside/x`)
    expect(a.writeEffects.externalWrite.value).toBe(true)
    expect(a.writeEffects.workspaceWrite.value).toBe("unknown")
  })

  test("copying to an absolute external destination is an external write", () => {
    const a = assess(`cp ${DIR}/a /etc/cron.d/x`)
    expect(a.writeEffects.externalWrite.value).toBe(true)
  })

  test("moving to a home directory outside the workspace is an external write", () => {
    const a = assess(`mv ${DIR}/a /root/b`)
    expect(a.writeEffects.externalWrite.value).toBe(true)
  })

  test("linking inside the workspace stays a workspace write", () => {
    const a = assess("ln -s ../project/src/index.ts link.ts")
    expect(a.writeEffects.workspaceWrite.value).toBe(true)
    expect(a.writeEffects.externalWrite.value).toBe("unknown")
  })

  test("copying within the workspace stays a workspace write", () => {
    const a = assess("cp src/a.ts src/b.ts")
    expect(a.writeEffects.workspaceWrite.value).toBe(true)
    expect(a.writeEffects.externalWrite.value).toBe("unknown")
  })

  test("rsync to a remote host is an external write", () => {
    const a = assess("rsync -a dist/ deploy@host.invalid:/srv/app")
    expect(a.writeEffects.externalWrite.value).toBe(true)
  })

  test("copying into a temp root is a temporary write", () => {
    const a = assess("cp src/a.ts /tmp/a.ts")
    expect(a.writeEffects.temporaryWrite.value).toBe(true)
    expect(a.writeEffects.workspaceWrite.value).toBe("unknown")
  })
})

describe("capability analyzer — classification matrix", () => {
  test("rm -rf /some/path → deletion + external write", () => {
    const a = assess("rm -rf /some/path")
    expect(a.writeEffects.deletion.value).toBe(true)
    expect(a.actionClass.value).toBe("destruction")
  })

  test("rm file.txt (relative) → workspace deletion", () => {
    const a = assess("rm file.txt")
    expect(a.writeEffects.deletion.value).toBe(true)
    expect(a.writeEffects.workspaceWrite.value).toBe(true)
    expect(a.actionClass.value).toBe("destruction")
  })

  test("pip install requests → package lifecycle scripts", () => {
    const a = assess("pip install requests")
    expect(a.invokesPackageLifecycleScripts.value).toBe(true)
    expect(a.actionClass.value).toBe("package-management")
  })

  test("git push --force origin main → git mutation + external write", () => {
    const a = assess("git push --force origin main")
    expect(a.git.observed.value).toBe(true)
    expect(a.git.possible.value).toBe(true)
    expect(a.writeEffects.externalWrite.value).toBe(true)
    expect(a.actionClass.value).toBe("git-mutation")
  })

  test("git status → read-only git, no mutation", () => {
    const a = assess("git status")
    expect(a.git.observed.value).toBe(true)
    expect(a.git.possible.value).toBe("unknown")
    expect(a.actionClass.value).toBe("read-only")
  })

  test("curl http://example.com/data → network observed + destination captured", () => {
    const a = assess("curl http://example.com/data")
    expect(a.network.observed.value).toBe(true)
    expect(a.network.destinations).toContain("http://example.com/data")
    expect(a.actionClass.value).toBe("network")
  })

  test("sudo systemctl restart nginx → privilege escalation + service management + persistence", () => {
    const a = assess("sudo systemctl restart nginx")
    expect(a.process.privilegeEscalation.value).toBe(true)
    expect(a.process.persistence.value).toBe(true)
    expect(a.actionClass.value).toBe("service-management")
  })

  test("nohup ./server & → persistence + child processes", () => {
    const a = assess("nohup ./server")
    expect(a.process.persistence.value).toBe(true)
    expect(a.process.childProcesses.value).toBe(true)
    expect(a.actionClass.value).toBe("persistence")
  })

  test("ssh host 'rm -rf /' → remote operation + remote mutation hint", () => {
    const a = assess("ssh host 'rm -rf /'")
    expect(a.remote.enabled.value).toBe(true)
    expect(a.remote.mutationHint.value).toBe(true)
    expect(a.actionClass.value).toBe("remote-operation")
  })

  test("bun test → test runner + repository code execution", () => {
    const a = assess("bun test")
    expect(a.invokesExistingTestRunner.value).toBe(true)
    expect(a.executesRepositoryCode.value).toBe(true)
    expect(a.actionClass.value).toBe("code-execution")
  })

  test("tee /tmp/out writes to a temp path", () => {
    const a = assess("echo data | tee /tmp/out")
    expect(a.writeEffects.temporaryWrite.value).toBe(true)
    expect(a.actionClass.value).toBe("temporary-write")
  })

  test("cat README.md → read-only", () => {
    const a = assess("cat README.md")
    expect(a.actionClass.value).toBe("read-only")
    expect(a.executesCode.value).toBe("unknown")
  })
})

describe("capability analyzer — dynamic constructs + parser completeness", () => {
  test("variable expansion marks partial", () => {
    const a = assess("rm -rf $TARGET")
    expect(a.parserCompleteness).toBe("partial")
    expect(a.analysisWarnings.some((w) => w.includes("dynamic constructs"))).toBe(true)
  })

  test("command substitution marks opaque", () => {
    const a = assess("echo $(curl http://evil.invalid/x)")
    expect(a.parserCompleteness).toBe("opaque")
  })

  test("single-quoted variables are NOT dynamic", () => {
    const a = assess("echo '$HOME is literal'")
    expect(a.parserCompleteness).toBe("complete-for-supported-form")
  })

  test("single-quoted variable mid-string is NOT dynamic", () => {
    const a = assess("echo 'literal $VAR here'")
    expect(a.parserCompleteness).toBe("complete-for-supported-form")
  })

  test("dynamic heredoc body marks opaque", () => {
    const cmd = "cat > /tmp/x <<EOF\n$(whoami)\nEOF"
    const a = assess(cmd)
    expect(a.parserCompleteness).toBe("opaque")
  })

  test("bare backtick command substitution marks opaque", () => {
    const a = assess("echo `whoami`")
    expect(a.parserCompleteness).toBe("opaque")
  })
})

describe("capability analyzer — privilege wrappers peeled", () => {
  test("sudo rm -rf / detects deletion under privilege escalation", () => {
    const a = assess("sudo rm -rf /")
    expect(a.writeEffects.deletion.value).toBe(true)
    expect(a.process.privilegeEscalation.value).toBe(true)
  })

  test("env rm -rf / peels the env wrapper", () => {
    const a = assess("env rm -rf /")
    expect(a.writeEffects.deletion.value).toBe(true)
  })
})

describe("capability analyzer — resilience", () => {
  test("empty command never throws and yields unknown action class", () => {
    const a = assess("")
    expect(a.actionClass.value).toBe("read-only")
    expect(a.parserCompleteness).toBe("complete-for-supported-form")
  })

  test("garbage input never throws", () => {
    const a = assess("{{{;;;|||&&&")
    expect(a).toBeDefined()
  })
})
