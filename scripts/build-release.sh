#!/usr/bin/env bash
#
# Build the EASY MXL release tarball.
#
# The tarball is what the one-line installer (install.sh) downloads from GitHub
# Releases: the compiled application (dist/), production node_modules, the
# deployment files and the host installer. A machine that installs it needs
# Node.js and Docker but no npm registry access and no TypeScript toolchain.
#
# Usage: scripts/build-release.sh [--skip-build] [--out <dir>]
#   --skip-build   reuse an existing dist/ instead of running npm ci + npm run build
#   --out <dir>    output directory (default: <repo>/release)
#
# Produces:
#   <out>/easy-mxl-<version>.tar.gz   (top-level directory easy-mxl-<version>/)
#   <out>/install.sh                  (copy of the bootstrap installer)
#   <out>/SHA256SUMS                  (checksums of both files)

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
OUT="${ROOT}/release"
SKIP_BUILD=0

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while (( $# )); do
  case $1 in
    --skip-build) SKIP_BUILD=1 ;;
    --out)
      [[ $# -ge 2 ]] || die "--out requires a directory"
      OUT=$2
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || die "node is required"
command -v npm >/dev/null 2>&1 || die "npm is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

VERSION=$(node -p "require('${ROOT}/package.json').version")
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "package.json version '${VERSION}' is not a semantic version"
NAME="easy-mxl-${VERSION}"
COMMIT=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)

cd "$ROOT"
if (( SKIP_BUILD )); then
  printf '==> Reusing existing dist/ (--skip-build)\n'
else
  printf '==> Installing dependencies and compiling\n'
  npm ci --no-audit --no-fund --loglevel=error
  npm run build
fi
[[ -f dist/bin/easy-mxl.js ]] || die "dist/bin/easy-mxl.js is missing; run npm run build first"

STAGE="${OUT}/${NAME}"
rm -rf "$STAGE"
mkdir -p "$STAGE/scripts"

printf '==> Staging %s\n' "$STAGE"
cp -a dist "$STAGE/dist"
rm -rf "$STAGE/dist/test"            # unit tests and fixtures are not needed at runtime
cp -a deploy "$STAGE/deploy"
cp -a scripts/install-ubuntu24.sh "$STAGE/scripts/"
cp -a package.json package-lock.json README.md LICENSE install.sh "$STAGE/"
[[ -f catalog/default.json ]] && cp -a catalog "$STAGE/catalog"

printf '==> Installing production dependencies into the stage\n'
# --ignore-scripts skips ssh2's optional native cpu-features build, so the
# resulting node_modules is plain JavaScript and works on amd64 and arm64.
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )
rm -rf "$STAGE/node_modules/.package-lock.json"

printf 'version=%s\ncommit=%s\nbuilt=%s\n' "$VERSION" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/.release-prebuilt"

printf '==> Writing %s/%s.tar.gz\n' "$OUT" "$NAME"
tar -C "$OUT" --owner=0 --group=0 --numeric-owner -czf "${OUT}/${NAME}.tar.gz" "$NAME"
cp -a install.sh "${OUT}/install.sh"
( cd "$OUT" && sha256sum "${NAME}.tar.gz" install.sh > SHA256SUMS )
rm -rf "$STAGE"

printf '\nRelease artifacts:\n'
ls -l "${OUT}/${NAME}.tar.gz" "${OUT}/install.sh" "${OUT}/SHA256SUMS"
printf '\n'
cat "${OUT}/SHA256SUMS"
