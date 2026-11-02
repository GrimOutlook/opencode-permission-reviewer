import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { PermissionRequest } from "../types.ts"

// Deliberately conservative path exclusions, not a content-secret detector.
const SENSITIVE_COMPONENT =
  /^(?:\.env(?:[.-].*)?|\.git|\.pi|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.config|\.npmrc|\.netrc|\.pypirc|secrets?|\.secrets?|credentials?(?:[.-].*)?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i
const SENSITIVE_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|age|gpg|kdbx)$/i

function within(path: string, root: string): boolean {
  const tail = relative(root, path)
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
}

function sensitive(path: string): boolean {
  return (
    path.split(sep).some((part) => SENSITIVE_COMPONENT.test(part)) || SENSITIVE_EXTENSION.test(path)
  )
}

/** Fast path only for a verified regular file in Pi's current working directory. */
export async function isOrdinaryProjectRead(
  request: PermissionRequest,
  cwd: string,
): Promise<boolean> {
  if (request.permission !== "read") return false
  const path = request.metadata.path
  if (typeof path !== "string" || !path || path.includes("\0")) return false
  // Pi expands these spellings before opening a read path. Leave them to
  // review rather than checking a different file than the host will open.
  if (
    process.platform === "win32" ||
    path.startsWith("@") ||
    path.startsWith("~") ||
    path.startsWith("file:") ||
    /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(path + cwd)
  )
    return false
  const lexical = resolve(cwd, path)
  if (!within(lexical, resolve(cwd)) || sensitive(lexical)) return false
  try {
    const [root, actual] = await Promise.all([realpath(cwd), realpath(lexical)])
    if (!within(actual, root) || sensitive(actual)) return false
    return (await stat(actual)).isFile()
  } catch {
    // Missing, unreadable, or otherwise ambiguous paths still need review.
    return false
  }
}
