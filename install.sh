#!/usr/bin/env bash
#
# EASY MXL - one-line installer for Ubuntu (22.04 / 24.04) hosts.
#
#   curl -fsSL https://github.com/CLOUDflex-broadcast/easy-mxl/releases/latest/download/install.sh | sudo bash
#
# What it does:
#   1. Installs Docker Engine from Docker's apt repository when `docker` is missing
#      (skip with --no-docker / EASY_MXL_SKIP_DOCKER=1).
#   2. Downloads the requested EASY MXL release tarball from GitHub Releases,
#      verifies its SHA-256 checksum and unpacks it.
#   3. Runs the bundled host installer (scripts/install-ubuntu24.sh --yes), which
#      installs Node.js 22 when needed, copies the prebuilt application to
#      /opt/easy-mxl, installs the systemd unit, creates /etc/default/easy-mxl
#      with a random API token and starts the service on port 9700.
#
# Options (flags win over environment variables):
#   --version <tag>      release to install, e.g. v0.1.0 (default: latest release)
#                        A value that is not a tag (e.g. "main") installs that git
#                        ref from source and builds it (needs npm registry access).
#   --tmpfs-volumes      also set up the mxl-hands-on tmpfs mount at /Volumes/mxl
#   --no-docker          do not install Docker Engine when it is missing
#   --uninstall          stop and remove the service and /opt/easy-mxl
#   --purge              with --uninstall: also delete /etc/default/easy-mxl
#   -h, --help           this text
#
# Environment:
#   EASY_MXL_VERSION, EASY_MXL_TMPFS_VOLUMES=1, EASY_MXL_SKIP_DOCKER=1
#   EASY_MXL_REPO=owner/repo      (default CLOUDflex-broadcast/easy-mxl)
#   EASY_MXL_TARBALL=/path.tar.gz (install a local release tarball; offline use)

set -euo pipefail

REPO=${EASY_MXL_REPO:-CLOUDflex-broadcast/easy-mxl}
EASY_MXL_REF=${EASY_MXL_VERSION:-latest}
TMPFS_VOLUMES=${EASY_MXL_TMPFS_VOLUMES:-0}
SKIP_DOCKER=${EASY_MXL_SKIP_DOCKER:-0}
LOCAL_TARBALL=${EASY_MXL_TARBALL:-}
UNINSTALL=0
PURGE=0

readonly INSTALL_DIR=/opt/easy-mxl
readonly UNIT_NAME=easy-mxl.service
readonly ENV_FILE=/etc/default/easy-mxl

usage() {
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

if [[ -t 1 ]]; then
  C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
info() { printf '%s==>%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok()   { printf '%s    ok%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%sWARNING:%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

while (( $# )); do
  case $1 in
    --version)
      [[ $# -ge 2 ]] || die "--version requires a value (e.g. v0.1.0)"
      EASY_MXL_REF=$2
      shift
      ;;
    --version=*) EASY_MXL_REF=${1#--version=} ;;
    --tmpfs-volumes) TMPFS_VOLUMES=1 ;;
    --no-docker) SKIP_DOCKER=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

(( EUID == 0 )) || die "Run this installer as root:  curl -fsSL <url>/install.sh | sudo bash"

have_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  local state
  state=$(systemctl is-system-running 2>/dev/null || true)
  [[ -n $state && $state != offline && $state != unknown ]]
}

# --- uninstall ---------------------------------------------------------------

if (( UNINSTALL )); then
  info "Removing EASY MXL"
  if have_systemd; then
    systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
  fi
  rm -f "/etc/systemd/system/${UNIT_NAME}"
  have_systemd && systemctl daemon-reload || true
  rm -rf "$INSTALL_DIR"
  ok "Service and ${INSTALL_DIR} removed"
  if (( PURGE )); then
    rm -f "$ENV_FILE"
    ok "${ENV_FILE} removed"
  else
    [[ -f $ENV_FILE ]] && ok "Kept ${ENV_FILE} (token and settings); add --purge to delete it"
  fi
  printf 'Docker, Node.js, MXL domains under /dev/shm/mxl and any media-function containers were left untouched.\n'
  exit 0
fi

# --- prerequisites -------------------------------------------------------------

command -v apt-get >/dev/null 2>&1 || die "This installer supports apt-based systems (Ubuntu 22.04 / 24.04). For other systems follow the manual steps in the documentation."
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ ${ID:-} == ubuntu ]]; then
    ok "Detected ${PRETTY_NAME}"
  else
    warn "This installer targets Ubuntu; detected '${PRETTY_NAME:-unknown}'. Continuing anyway."
  fi
fi

APT_UPDATED=0
apt_install() {
  if (( ! APT_UPDATED )); then
    apt-get update -qq
    APT_UPDATED=1
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
}

missing=()
for tool in curl tar gpg sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if (( ${#missing[@]} )); then
  info "Installing prerequisites: ${missing[*]}"
  apt_install ca-certificates curl tar gnupg coreutils
fi

# --- Docker Engine ---------------------------------------------------------------

install_docker() {
  info "Installing Docker Engine from download.docker.com"
  apt_install ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID:-ubuntu}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  local codename
  codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
  [[ -n $codename ]] || die "Cannot determine the distribution codename for the Docker apt repository"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "${ID:-ubuntu}" "$codename" > /etc/apt/sources.list.d/docker.list
  APT_UPDATED=0
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if have_systemd; then
    systemctl enable --now docker
  fi
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'installed')"
}

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '') is running"
  elif have_systemd; then
    info "Starting the Docker daemon"
    systemctl enable --now docker
    docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not reachable (systemctl status docker)"
  else
    die "Docker is installed but the daemon is not reachable. Start it and re-run."
  fi
elif (( SKIP_DOCKER )); then
  die "Docker is not installed and --no-docker was given. Install Docker Engine first: https://docs.docker.com/engine/install/ubuntu/"
else
  install_docker
fi

# --- download the release ------------------------------------------------------------

WORK=$(mktemp -d /tmp/easy-mxl-install.XXXXXX)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

resolve_latest_tag() {
  # GitHub redirects /releases/latest to /releases/tag/<tag>; read the tag from the final URL.
  local final
  final=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" 2>/dev/null || true)
  if [[ $final =~ /releases/tag/([^/?#]+)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  # Fallback: the REST API (rate limited for anonymous callers, hence second choice).
  curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | sed -nE 's/.*"tag_name": *"([^"]+)".*/\1/p' | head -n 1
}

SRC=""
if [[ -n $LOCAL_TARBALL ]]; then
  [[ -f $LOCAL_TARBALL ]] || die "EASY_MXL_TARBALL=${LOCAL_TARBALL} does not exist"
  info "Using local tarball ${LOCAL_TARBALL}"
  tar -C "$WORK" -xzf "$LOCAL_TARBALL"
elif [[ $EASY_MXL_REF == latest || $EASY_MXL_REF == v* ]]; then
  if [[ $EASY_MXL_REF == latest ]]; then
    info "Looking up the latest release of ${REPO}"
    EASY_MXL_REF=$(resolve_latest_tag)
    [[ -n $EASY_MXL_REF ]] || die "Could not determine the latest release of ${REPO}. No release published yet? Use --version main to install from source."
  fi
  TARBALL="easy-mxl-${EASY_MXL_REF#v}.tar.gz"
  BASE="https://github.com/${REPO}/releases/download/${EASY_MXL_REF}"
  info "Downloading ${TARBALL} (${EASY_MXL_REF})"
  curl -fsSL --retry 3 -o "${WORK}/${TARBALL}" "${BASE}/${TARBALL}" \
    || die "Download failed: ${BASE}/${TARBALL}"
  if curl -fsSL --retry 3 -o "${WORK}/SHA256SUMS" "${BASE}/SHA256SUMS"; then
    ( cd "$WORK" && grep " ${TARBALL}\$" SHA256SUMS | sha256sum -c --quiet - ) || die "Checksum verification failed for ${TARBALL}"
    ok "Checksum verified"
  else
    warn "SHA256SUMS not found for ${EASY_MXL_REF}; skipping checksum verification"
  fi
  tar -C "$WORK" -xzf "${WORK}/${TARBALL}"
else
  info "Downloading source tree for ref '${EASY_MXL_REF}' (will be compiled on this host)"
  curl -fsSL --retry 3 -o "${WORK}/src.tar.gz" "https://codeload.github.com/${REPO}/tar.gz/${EASY_MXL_REF}" \
    || die "Could not download https://github.com/${REPO} at ref '${EASY_MXL_REF}'"
  tar -C "$WORK" -xzf "${WORK}/src.tar.gz"
fi

SRC=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[[ -n $SRC && -f "${SRC}/scripts/install-ubuntu24.sh" ]] || die "The downloaded archive does not contain scripts/install-ubuntu24.sh"
if [[ -f "${SRC}/.release-prebuilt" ]]; then
  ok "Prebuilt release: $(tr '\n' ' ' < "${SRC}/.release-prebuilt")"
fi

# --- hand over to the host installer -------------------------------------------------

args=(--yes)
(( TMPFS_VOLUMES )) && args+=(--tmpfs-volumes)
info "Running the host installer"
bash "${SRC}/scripts/install-ubuntu24.sh" "${args[@]}"
