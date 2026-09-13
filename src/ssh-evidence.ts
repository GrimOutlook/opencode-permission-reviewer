import { createHash } from "node:crypto"
import { open, realpath, stat } from "node:fs/promises"
import { basename, isAbsolute, resolve, sep } from "node:path"
import type { PermissionRequest } from "./types.ts"
import { sourceCommand } from "./evidence/source-command.ts"
import { lexSegments, type ShellSegment, type ShellToken } from "./shell-lexer.ts"

export interface FileEvidence {
  source: "file"
  path: string
  status: "included" | "truncated" | "unavailable" | "blocked"
  reason?: string
  size?: number
  includedBytes?: number
  includedSha256?: string
  content?: string
}

export interface SshAuditSummary {
  destination: string
  port?: string
  remoteCommandSha256?: string
  stdinSource?: string
  stdinStatus?: string
  stdinReason?: string
}

export interface SshEnrichmentResult {
  text: string
  audit: SshAuditSummary[]
  preflightDenial?: string
}

const OPTION_WITH_VALUE = new Set([
  "-B",
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
])

const SENSITIVE_PATH =
  /(?:^|\/)(?:\.env(?:\.|$)|\.ssh(?:\/|$)|\.aws(?:\/|$)|\.config\/gcloud(?:\/|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|credentials(?:\.json)?$|authorized_keys$|known_hosts$|\.npmrc$|\.pypirc$|\.netrc$)/i
const SENSITIVE_CONTENT =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat|nvapi)-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["'][^"'\n]{8,}["']/i

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

/*
 * Segmentation for the evidence providers.
 *
 * This used to be a second, independent tokenizer, which disagreed with the
 * emergency brake's lexer about comments, parentheses, and escaping — so the
 * reviewer could be handed facts derived from a different reading of the
 * command than the one the brake judged (`ssh host cmd # rm -rf /` reported
 * remote-mutation signals from a comment). Both paths now share
 * `lexSegments`; this layer only adapts its output shape.
 */
function commandSegments(command: string): ShellSegment[] {
  return lexSegments(command)
}

export function shellCommandSegments(
  command: string,
): Array<{ tokens: string[]; preceding?: string }> {
  return commandSegments(command).map((segment) => ({
    tokens: segment.tokens.map((token) => token.value),
    ...(segment.preceding === undefined ? {} : { preceding: segment.preceding }),
  }))
}

export interface ShellCommandSegmentWithDirectory {
  tokens: string[]
  preceding?: string
  directory?: string
  directoryReason?: string
}

function cdTarget(tokens: string[], directory: string): { directory?: string; reason?: string } {
  if (tokens.length < 2 || commandName(tokens[0]!) !== "cd") return {}
  const values = tokens[1] === "--" ? tokens.slice(2) : tokens.slice(1)
  if (values.length !== 1) return { reason: "cd target is absent or ambiguous" }
  const target = values[0]!
  if (/[$`*?{}<>]/.test(target)) return { reason: "cd target contains unresolved shell expansion" }
  return { directory: resolve(directory, target) }
}

export function shellCommandSegmentsWithDirectory(
  command: string,
  initialDirectory: string,
): ShellCommandSegmentWithDirectory[] {
  const segments = shellCommandSegments(command)
  const result: ShellCommandSegmentWithDirectory[] = []
  let directory = resolve(initialDirectory)
  let directoryReason: string | undefined
  let pendingCd: { before: string; target?: string; reason?: string } | undefined

  for (const segment of segments) {
    if (pendingCd) {
      if (segment.preceding === "&&") {
        if (pendingCd.target) {
          directory = pendingCd.target
          directoryReason = undefined
        } else {
          directoryReason = pendingCd.reason ?? "preceding cd target is unresolved"
        }
      } else if (segment.preceding === "||") {
        directory = pendingCd.before
        directoryReason = undefined
      } else {
        directoryReason = "working directory after cd is conditional or ambiguous"
      }
      pendingCd = undefined
    }

    result.push({
      ...segment,
      ...(directoryReason === undefined ? { directory } : { directoryReason }),
    })

    if (segment.tokens.length > 0 && commandName(segment.tokens[0]!) === "cd") {
      const target = cdTarget(segment.tokens, directory)
      pendingCd = {
        before: directory,
        ...(target.directory === undefined ? {} : { target: target.directory }),
        ...(target.reason === undefined ? {} : { reason: target.reason }),
      }
    }
  }
  return result
}

function commandName(value: string): string {
  return basename(value)
}

function findSshIndex(tokens: ShellToken[]): number {
  return tokens.findIndex((token) => commandName(token.value) === "ssh")
}

function optionValue(token: string, option: string): string | undefined {
  if (token === option) return
  if (token.startsWith(option) && token.length > option.length) return token.slice(option.length)
  return
}

function parseSsh(
  tokens: ShellToken[],
  sshIndex: number,
):
  | {
      destination: string
      host: string
      user?: string
      port?: string
      identityFile?: string
      strictHostKeyChecking?: string
      remoteCommand: string
    }
  | undefined {
  let destination: string | undefined
  let port: string | undefined
  let identityFile: string | undefined
  let strictHostKeyChecking: string | undefined
  let index = sshIndex + 1

  while (index < tokens.length) {
    const token = tokens[index]!.value
    if (token === "--") {
      index += 1
      destination = tokens[index]?.value
      index += 1
      break
    }
    if (!token.startsWith("-") || token === "-") {
      destination = token
      index += 1
      break
    }

    const identityInline = optionValue(token, "-i")
    const portInline = optionValue(token, "-p")
    const optionInline = optionValue(token, "-o")
    if (identityInline !== undefined) identityFile = identityInline
    else if (portInline !== undefined) port = portInline
    else if (optionInline !== undefined) {
      const match = /^StrictHostKeyChecking=(.+)$/i.exec(optionInline)
      if (match) strictHostKeyChecking = match[1]
    }

    if (OPTION_WITH_VALUE.has(token)) {
      const following = tokens[index + 1]?.value
      if (token === "-i") identityFile = following
      if (token === "-p") port = following
      if (token === "-o" && following) {
        const match = /^StrictHostKeyChecking=(.+)$/i.exec(following)
        if (match) strictHostKeyChecking = match[1]
      }
      index += 2
    } else {
      index += 1
    }
  }

  if (!destination) return
  const at = destination.lastIndexOf("@")
  const user = at > 0 ? destination.slice(0, at) : undefined
  const host = at > 0 ? destination.slice(at + 1) : destination
  const remoteTokens = tokens.slice(index).map((token) => token.value)
  while (remoteTokens.length > 0 && /^\d*(?:>|<)/.test(remoteTokens.at(-1)!)) remoteTokens.pop()
  return {
    destination,
    host,
    ...(user === undefined ? {} : { user }),
    ...(port === undefined ? {} : { port }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(strictHostKeyChecking === undefined ? {} : { strictHostKeyChecking }),
    remoteCommand: remoteTokens.join(" "),
  }
}

function catSource(tokens: ShellToken[]): string | undefined {
  if (tokens.length < 2 || commandName(tokens[0]!.value) !== "cat") return
  const values = tokens.slice(1).map((token) => token.value)
  const positional = values.filter((value) => value !== "--" && !value.startsWith("-"))
  if (positional.length !== 1) return
  const source = positional[0]!
  if (/[$`*?{}<>]/.test(source)) return
  return source
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

async function includeFileOnce(
  source: string,
  directory: string,
  worktree: string,
  maxChars: number,
): Promise<FileEvidence> {
  const resolved = resolve(directory, source)
  if (SENSITIVE_PATH.test(resolved)) {
    return { source: "file", path: resolved, status: "blocked", reason: "sensitive path" }
  }

  try {
    // Resolve the source independently so ENOENT can only mean that this
    // specific stdin file is missing, never that an auxiliary root vanished.
    const actual = await realpath(resolved)
    const [directoryRoot, worktreeRoot, temporaryRoot] = await Promise.all([
      realpath(directory).catch(() => resolve(directory)),
      realpath(worktree).catch(() => resolve(worktree)),
      realpath("/tmp/opencode").catch(() => "/tmp/opencode"),
    ])
    if (![directoryRoot, worktreeRoot, temporaryRoot].some((root) => within(actual, root))) {
      return {
        source: "file",
        path: resolved,
        status: "blocked",
        reason: "outside approved enrichment roots",
      }
    }
    if (SENSITIVE_PATH.test(actual)) {
      return {
        source: "file",
        path: resolved,
        status: "blocked",
        reason: "sensitive resolved path",
      }
    }

    const info = await stat(actual)
    if (!info.isFile()) {
      return { source: "file", path: resolved, status: "unavailable", reason: "not a regular file" }
    }

    const limit = Math.max(1, maxChars)
    const handle = await open(actual, "r")
    try {
      const buffer = Buffer.alloc(Math.min(info.size, limit + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const included = buffer.subarray(0, Math.min(bytesRead, limit))
      const content = included.toString("utf8")
      const replacementCount = [...content].filter((character) => character === "\uFFFD").length
      if (included.includes(0) || replacementCount > Math.max(2, content.length / 100)) {
        return {
          source: "file",
          path: resolved,
          status: "blocked",
          reason: "binary or non-text content",
          size: info.size,
        }
      }
      if (SENSITIVE_CONTENT.test(content)) {
        return {
          source: "file",
          path: resolved,
          status: "blocked",
          reason: "possible literal credential or private key",
          size: info.size,
          includedSha256: sha256(included),
        }
      }
      return {
        source: "file",
        path: resolved,
        status: info.size > limit ? "truncated" : "included",
        size: info.size,
        includedBytes: included.length,
        includedSha256: sha256(included),
        content,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return {
      source: "file",
      path: isAbsolute(source) ? source : resolved,
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function isMissingFile(result: FileEvidence): boolean {
  return (
    result.status === "unavailable" &&
    /\bENOENT\b|no such file or directory/i.test(result.reason ?? "")
  )
}

export async function includeEvidenceFile(
  source: string,
  directory: string,
  worktree: string,
  maxChars: number,
): Promise<FileEvidence> {
  const first = await includeFileOnce(source, directory, worktree, maxChars)
  if (!isMissingFile(first)) return first
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100))
  return includeFileOnce(source, directory, worktree, maxChars)
}

function deterministicDenial(stdin: FileEvidence | undefined): string | undefined {
  if (!stdin) return
  if (isMissingFile(stdin)) {
    return `The file sent over stdin does not exist after a second check: ${stdin.path}. Create it and retry the command.`
  }
  return
}

function commandSignals(remoteCommand: string, hasStdin: boolean): Record<string, boolean> {
  return {
    stagingHint: /\bstag(?:e|ing)?\b/i.test(remoteCommand),
    productionHint: /\bprod(?:uction)?\b/i.test(remoteCommand),
    executesStdin: hasStdin && /\b(?:python(?:3)?|bash|sh|node|ruby|perl)\s+-$/.test(remoteCommand),
    secretReadHint:
      /\b(?:env|printenv)\b|(?:^|[\s/])\.env\b|\/proc\/\d+\/environ\b|(?:cat|sed|grep)\s+[^\n;]*(?:credential|secret|token|private[_-]?key)/i.test(
        remoteCommand,
      ),
    mutationHint:
      /\b(?:rm|mv|cp|install|deploy|restart|stop|start|kill|reboot|shutdown|chmod|chown|truncate|tee|docker\s+(?:rm|restart|stop|kill|compose\s+(?:up|down))|kubectl\s+(?:apply|delete|patch|rollout)|systemctl\s+(?:restart|stop|start|enable|disable))\b/i.test(
        remoteCommand,
      ),
  }
}

export function analyzeScriptContent(content: string): Record<string, unknown> {
  const outboundUrls = [...content.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g)]
    .map((match) => match[0])
    .slice(0, 8)
  return {
    credentialPathReadHint:
      /(?:read_text|read_bytes|open)\s*\([^)]*(?:\.ssh\/id_|\.aws\/credentials|\.env\b|credential|private[_-]?key)/i.test(
        content,
      ) ||
      /Path\s*\([^)]*(?:\.ssh\/id_|\.aws\/credentials|\.env\b|credential|private[_-]?key)[^)]*\)\s*\.\s*(?:read_text|read_bytes|open)/i.test(
        content,
      ),
    environmentEnumerationHint:
      /\bos\.environ\b|\bprocess\.env\b|\bprintenv\b|(?:^|[^\w])env(?:[^\w]|$)/m.test(content),
    networkUploadHint:
      /\brequests?\.(?:post|put|patch)\s*\(|\burlopen\s*\([^)]*(?:data\s*=|Request)|\bmethod\s*=\s*["'](?:POST|PUT|PATCH)["']|\bcurl\b[^\n]*(?:--data|-d\b|-T\b|--upload-file)/i.test(
        content,
      ),
    dynamicExecutionHint:
      /\b(?:exec|eval|compile)\s*\(|\bsubprocess\.(?:run|Popen|call)\s*\(|\bos\.system\s*\(|\bchild_process\.(?:exec|spawn)\s*\(/i.test(
        content,
      ),
    fileMutationHint:
      /\.(?:write_text|write_bytes|unlink|rename|replace)\s*\(|\bopen\s*\([^)]*,\s*["'][wax+]|\bshutil\.(?:rmtree|move|copy|copy2)\s*\(|\bos\.(?:remove|unlink|rename|replace)\s*\(/i.test(
        content,
      ),
    databaseMutationHint:
      /\b(?:alter|drop|truncate|delete\s+from|update|insert\s+into|create\s+(?:table|index)|grant|revoke)\b/i.test(
        content,
      ),
    outboundUrls,
  }
}

function stdinSignals(stdin: FileEvidence | undefined): Record<string, unknown> | undefined {
  if (!stdin?.content) return
  return analyzeScriptContent(stdin.content)
}

export async function enrichSshEvidence(
  request: PermissionRequest,
  directory: string,
  worktree: string,
  maxChars: number,
): Promise<SshEnrichmentResult> {
  if (request.permission !== "bash") return { text: "", audit: [] }
  const command = sourceCommand(request)
  if (!/(?:^|[\s;&|])ssh(?:\s|$)/.test(command)) return { text: "", audit: [] }

  const segments = commandSegments(command)
  const records: Array<Record<string, unknown>> = []
  const audit: SshAuditSummary[] = []
  const preflightDenials: string[] = []

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]!
    const sshIndex = findSshIndex(segment.tokens)
    if (sshIndex < 0) continue
    const parsed = parseSsh(segment.tokens, sshIndex)
    if (!parsed) continue

    const previous = segmentIndex > 0 ? segments[segmentIndex - 1] : undefined
    const stdinPath = segment.preceding === "|" && previous ? catSource(previous.tokens) : undefined
    const stdin =
      stdinPath === undefined
        ? undefined
        : await includeEvidenceFile(stdinPath, directory, worktree, maxChars)
    const remoteCommandSha256 = parsed.remoteCommand ? sha256(parsed.remoteCommand) : undefined
    const analyzedStdin = stdinSignals(stdin)
    const denial = deterministicDenial(stdin)
    if (denial) preflightDenials.push(denial)
    const record = {
      kind: "ssh",
      destination: parsed.destination,
      host: parsed.host,
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
      ...(parsed.identityFile === undefined ? {} : { identityFile: parsed.identityFile }),
      ...(parsed.strictHostKeyChecking === undefined
        ? {}
        : { strictHostKeyChecking: parsed.strictHostKeyChecking }),
      remoteCommand: parsed.remoteCommand || "<interactive or unspecified>",
      ...(remoteCommandSha256 === undefined ? {} : { remoteCommandSha256 }),
      signals: commandSignals(parsed.remoteCommand, stdin !== undefined),
      ...(analyzedStdin === undefined ? {} : { stdinSignals: analyzedStdin }),
      ...(stdin === undefined
        ? segment.preceding === "|"
          ? {
              stdin: {
                status: "unresolved",
                reason: "pipeline producer is not one regular cat file",
              },
            }
          : {}
        : { stdin }),
    }
    records.push(record)
    audit.push({
      destination: parsed.destination,
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
      ...(remoteCommandSha256 === undefined ? {} : { remoteCommandSha256 }),
      ...(stdin === undefined ? {} : { stdinSource: stdin.path, stdinStatus: stdin.status }),
      ...(stdin?.reason === undefined ? {} : { stdinReason: stdin.reason }),
    })
  }

  if (records.length === 0) return { text: "", audit: [] }
  const serialized = JSON.stringify(records, null, 2)
  const bounded =
    serialized.length <= maxChars
      ? serialized
      : `${serialized.slice(0, maxChars)}\n<ssh_enrichment_truncated characters="${serialized.length - maxChars}" />`
  return {
    text: `SSH_ANALYSIS\n${bounded}`,
    audit,
    ...(preflightDenials.length === 0 ? {} : { preflightDenial: preflightDenials.join(" ") }),
  }
}

/** Test hook: the shared tokenizer as the evidence path sees it. */
export const _shellTokensForTest = (command: string): Array<{ value: string }> =>
  lexSegments(command).flatMap((segment) => segment.tokens)
