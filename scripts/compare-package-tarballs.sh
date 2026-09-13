#!/usr/bin/env bash
#
# Compare two npm package tarballs by content.
#
# The release workflow packs and inspects one tarball, then lets `npm publish`
# repack the repository (publishing a pre-packed tarball would forfeit
# provenance). This script closes the resulting integrity gap: the two packs
# must contain the same files with the same SHA-256 digests. Gzip framing,
# compression level, and mtimes are allowed to differ; contents are not.
#
# Usage: compare-package-tarballs.sh <inspected.tgz> <published.tgz> [manifest-out]
# Exit status: 0 when the contents match, 1 when they differ or on bad usage.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <inspected.tgz> <published.tgz> [manifest-out]" >&2
  exit 1
fi

inspected="$1"
published="$2"
manifest_out="${3:-}"

for tarball in "$inspected" "$published"; do
  if [ ! -f "$tarball" ]; then
    echo "error: no such tarball: $tarball" >&2
    exit 1
  fi
done

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# npm tarballs always root their contents at `package/`.
manifest() {
  local tarball="$1" out="$2" root="$3"
  mkdir -p "$root"
  tar -xzf "$tarball" -C "$root"
  if [ ! -d "$root/package" ]; then
    echo "error: $tarball is not an npm package tarball (no package/ root)" >&2
    exit 1
  fi
  (cd "$root/package" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$out"
}

manifest "$inspected" "$workdir/inspected.txt" "$workdir/a"
manifest "$published" "$workdir/published.txt" "$workdir/b"

if ! diff -u --label inspected --label published "$workdir/inspected.txt" "$workdir/published.txt"; then
  echo "error: published tarball does not match the inspected tarball" >&2
  exit 1
fi

count=$(wc -l <"$workdir/inspected.txt" | tr -d ' ')
echo "published tarball matches the inspected tarball ($count files)"

if [ -n "$manifest_out" ]; then
  cp "$workdir/inspected.txt" "$manifest_out"
fi
