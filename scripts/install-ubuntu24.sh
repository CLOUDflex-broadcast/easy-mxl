#!/usr/bin/env bash
#
# EASY MXL host installer for Ubuntu 24.04.
#
# Copies this repository (a source checkout, or a prebuilt release tarball from
# GitHub Releases) to /opt/easy-mxl, installs production dependencies and
# compiles the TypeScript sources when they are not prebuilt, installs the
# systemd unit, creates /etc/default/easy-mxl with a random API token and
# starts the service. Safe to re-run: every step is idempotent and an existing
# /etc/default/easy-mxl is never modified.
#
# Usage: sudo scripts/install-ubuntu24.sh [--yes] [--tmpfs-volumes] [--help]

set -euo pipefail

readonly INSTALL_DIR=/opt/easy-mxl
readonly UNIT_NAME=easy-mxl.service
readonly UNIT_DST="/etc/systemd/system/${UNIT_NAME}"
readonly ENV_FILE=/etc/default/easy-mxl
readonly MIN_NODE_MAJOR=20
readonly NODESOURCE_MAJOR=22
readonly TMPFS_MOUNTPOINT=/Volumes/mxl
readonly TMPFS_FSTAB_LINE='tmpfs /Volumes/mxl tmpfs defaults,noatime,size=512M,uid=1000,gid=1000,mode=0755 0 0'

ASSUME_YES=0
TMPFS_VOLUMES=0
GENERATED_TOKEN=""

usage() {
  cat <<EOF
EASY MXL installer for Ubuntu 24.04 (run with sudo)

Usage: sudo $0 [options]

Options:
  -y, --yes          Do not prompt; accept the Node.js 22.x installation from
                     NodeSource when Node.js >= ${MIN_NODE_MAJOR} is missing.
      --tmpfs-volumes
                     Also add the mxl-hands-on tmpfs mount to /etc/fstab and
                     mount it now:
                       ${TMPFS_FSTAB_LINE}
                     Use it when you want to share domains with the hands-on
                     docker-compose files (which expect /Volumes/mxl/domain_1).
  -h, --help         Show this help and exit.

What the script does:
  1. Checks the OS (warns when it is not Ubuntu 24.x), the docker CLI and the
     Docker daemon (docker info).
  2. Checks for Node.js >= ${MIN_NODE_MAJOR}; offers to install ${NODESOURCE_MAJOR}.x from NodeSource.
  3. Copies the repository (the parent directory of this script) to
     ${INSTALL_DIR}. A source checkout is compiled there (npm ci, npm run
     build, npm prune --omit=dev); a prebuilt release tarball (marker file
     .release-prebuilt with dist/ and node_modules/) is copied as-is, so no
     npm registry access is needed.
  4. Installs ${UNIT_DST}.
  5. Creates ${ENV_FILE} from deploy/easy-mxl.env.example with a random
     EASY_MXL_TOKEN (printed once) when the file does not exist yet.
  6. systemctl daemon-reload / enable / restart easy-mxl and prints the URL.
EOF
}

# --- output helpers ---------------------------------------------------------

if [[ -t 1 ]]; then
  C_INFO=$'\033[1;34m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OK=$'\033[1;32m'; C_OFF=$'\033[0m'
else
  C_INFO=""; C_WARN=""; C_ERR=""; C_OK=""; C_OFF=""
fi

info() { printf '%s==>%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok()   { printf '%s   %s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%sWARNING:%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

trap 'printf "%sERROR:%s installation aborted (command failed at line %s)\n" "$C_ERR" "$C_OFF" "$LINENO" >&2' ERR

# Ask a yes/no question. --yes answers yes; a non-interactive stdin without
# --yes is an error so the script never hangs in automation.
confirm() {
  local prompt=$1 reply
  if (( ASSUME_YES )); then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "${prompt} - cannot ask (stdin is not a terminal). Re-run with --yes to accept automatically."
  fi
  read -r -p "${prompt} [y/N] " reply
  [[ $reply =~ ^[Yy]([Ee][Ss])?$ ]]
}

have_systemd() {
  local state
  [[ -d /run/systemd/system ]] || return 1
  state=$(systemctl is-system-running 2>/dev/null || true)
  [[ $state == running || $state == degraded ]]
}

# --- argument parsing -------------------------------------------------------

ORIGINAL_ARGS=("$@")
while (( $# )); do
  case $1 in
    -y|--yes) ASSUME_YES=1 ;;
    --tmpfs-volumes) TMPFS_VOLUMES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

(( EUID == 0 )) || die "This script must be run as root: sudo $0 ${ORIGINAL_ARGS[*]:-}"

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -f "${SRC_DIR}/package.json" && -f "${SRC_DIR}/deploy/${UNIT_NAME}" ]] \
  || die "Cannot find the EASY MXL repository next to this script (looked in ${SRC_DIR})."

# A release tarball ships the compiled application and its production
# dependencies; only Node.js is needed to run it.
PREBUILT=0
if [[ -f "${SRC_DIR}/.release-prebuilt" && -f "${SRC_DIR}/dist/bin/easy-mxl.js" && -d "${SRC_DIR}/node_modules" ]]; then
  PREBUILT=1
fi

# --- 1. OS and Docker -------------------------------------------------------

info "Checking the operating system"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.* ]]; then
    ok "${PRETTY_NAME}"
  else
    warn "This installer targets Ubuntu 24.04; detected '${PRETTY_NAME:-unknown}'. Continuing anyway."
  fi
else
  warn "/etc/os-release not found; cannot verify the distribution. Continuing anyway."
fi

info "Checking Docker"
command -v docker >/dev/null 2>&1 || die "The docker CLI is not installed. Install Docker Engine (docker-ce) first:
  https://docs.docker.com/engine/install/ubuntu/
  or follow https://github.com/cbcrc/mxl-hands-on/blob/main/Preparation/WSL-Ubuntu.md"
if docker info >/dev/null 2>&1; then
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '(version unknown)') is running"
else
  die "The docker CLI is installed but the daemon is not reachable. Start it with: systemctl enable --now docker"
fi

# --- 2. Node.js -------------------------------------------------------------

node_major() {
  "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

# Prefer /usr/bin/node (what the unit file references), then whatever is on PATH.
find_node() {
  local candidate
  for candidate in /usr/bin/node "$(command -v node 2>/dev/null || true)"; do
    [[ -n $candidate && -x $candidate ]] || continue
    if (( $(node_major "$candidate") >= MIN_NODE_MAJOR )); then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

install_nodesource() {
  info "Installing Node.js ${NODESOURCE_MAJOR}.x from NodeSource"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' \
    "$NODESOURCE_MAJOR" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
}

info "Checking Node.js (>= ${MIN_NODE_MAJOR} required, 22 recommended)"
if NODE_BIN=$(find_node); then
  ok "Node.js $("$NODE_BIN" --version) at ${NODE_BIN}"
else
  if command -v node >/dev/null 2>&1; then
    warn "Node.js $(node --version 2>/dev/null || echo '?') found, but EASY MXL needs >= ${MIN_NODE_MAJOR}. (Ubuntu's own 'nodejs' package is too old.)"
  else
    warn "Node.js is not installed."
  fi
  if confirm "Install Node.js ${NODESOURCE_MAJOR}.x from NodeSource now (adds an apt repository)?"; then
    install_nodesource
    NODE_BIN=$(find_node) || die "Node.js installation finished but no usable node binary was found."
    ok "Node.js $("$NODE_BIN" --version) at ${NODE_BIN}"
  else
    die "Install Node.js >= ${MIN_NODE_MAJOR} (https://nodejs.org or NodeSource) and re-run this script."
  fi
fi

NODE_DIR=$(dirname "$NODE_BIN")
if [[ -x "${NODE_DIR}/npm" ]]; then
  NPM_BIN="${NODE_DIR}/npm"
else
  NPM_BIN=$(command -v npm 2>/dev/null || true)
  if [[ -z $NPM_BIN ]] && (( ! PREBUILT )); then
    die "npm was not found next to ${NODE_BIN} or on PATH (needed to compile a source checkout)."
  fi
fi

# --- 3. Copy the repository and install dependencies ------------------------

info "Installing EASY MXL to ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
if [[ "$(cd "$INSTALL_DIR" && pwd -P)" == "$SRC_DIR" ]]; then
  ok "Running from ${INSTALL_DIR} itself; nothing to copy"
else
  # A prebuilt release brings its own node_modules; a source checkout gets them installed below.
  copy_excludes=(--exclude .git)
  (( PREBUILT )) || copy_excludes+=(--exclude node_modules)
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${copy_excludes[@]}" "${SRC_DIR}/" "${INSTALL_DIR}/"
  else
    # tar fallback: overwrites files but does not remove files deleted upstream.
    tar_excludes=(--exclude=./.git)
    (( PREBUILT )) || tar_excludes+=(--exclude=./node_modules)
    tar -C "$SRC_DIR" "${tar_excludes[@]}" -cf - . | tar -C "$INSTALL_DIR" -xf -
  fi
  ok "Files copied from ${SRC_DIR}"
fi

if (( PREBUILT )); then
  [[ -f "${INSTALL_DIR}/dist/bin/easy-mxl.js" ]] || die "${INSTALL_DIR}/dist/bin/easy-mxl.js is missing; the release tarball looks incomplete."
  ok "Prebuilt release ($(tr '\n' ' ' < "${INSTALL_DIR}/.release-prebuilt")): skipping npm install and build"
else
  [[ -f "${INSTALL_DIR}/bin/easy-mxl.ts" ]] || die "${INSTALL_DIR}/bin/easy-mxl.ts is missing; the source checkout looks incomplete."
  info "Installing dependencies and compiling TypeScript"
  ( cd "$INSTALL_DIR" && PATH="${NODE_DIR}:${PATH}" "$NPM_BIN" ci --no-audit --no-fund --loglevel=error )
  ( cd "$INSTALL_DIR" && PATH="${NODE_DIR}:${PATH}" "$NPM_BIN" run build )
  ( cd "$INSTALL_DIR" && PATH="${NODE_DIR}:${PATH}" "$NPM_BIN" prune --omit=dev --no-audit --no-fund --loglevel=error )
  ok "Application compiled and production dependencies installed"
fi

# --- 4. systemd unit --------------------------------------------------------

info "Installing ${UNIT_DST}"
UNIT_TMP=$(mktemp)
if [[ $NODE_BIN == /usr/bin/node ]]; then
  cp "${INSTALL_DIR}/deploy/${UNIT_NAME}" "$UNIT_TMP"
else
  # The shipped unit references /usr/bin/node; point it at the node we found.
  sed "s|^ExecStart=/usr/bin/node |ExecStart=${NODE_BIN} |" "${INSTALL_DIR}/deploy/${UNIT_NAME}" > "$UNIT_TMP"
  warn "Node.js is at ${NODE_BIN}, not /usr/bin/node; ExecStart= was adjusted in the installed unit."
fi
install -D -m 0644 "$UNIT_TMP" "$UNIT_DST"
rm -f "$UNIT_TMP"
ok "Unit installed"

# --- 5. /etc/default/easy-mxl -----------------------------------------------

info "Configuring ${ENV_FILE}"
if [[ -f $ENV_FILE ]]; then
  ok "${ENV_FILE} exists; leaving it untouched"
  if ! grep -qE '^[[:space:]]*EASY_MXL_TOKEN=.+' "$ENV_FILE"; then
    warn "No EASY_MXL_TOKEN in ${ENV_FILE} while the unit listens on 0.0.0.0: the API (full Docker control) is unauthenticated.
         Add a line like  EASY_MXL_TOKEN=$(openssl rand -hex 16 2>/dev/null || echo '<random secret>')  and run: systemctl restart easy-mxl"
  fi
else
  if command -v openssl >/dev/null 2>&1; then
    GENERATED_TOKEN=$(openssl rand -hex 16)
  else
    GENERATED_TOKEN=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  fi
  ENV_TMP=$(mktemp)
  cp "${INSTALL_DIR}/deploy/easy-mxl.env.example" "$ENV_TMP"
  if grep -qE '^#?EASY_MXL_TOKEN=' "$ENV_TMP"; then
    sed -i -E "s|^#?EASY_MXL_TOKEN=.*|EASY_MXL_TOKEN=${GENERATED_TOKEN}|" "$ENV_TMP"
  else
    printf '\nEASY_MXL_TOKEN=%s\n' "$GENERATED_TOKEN" >> "$ENV_TMP"
  fi
  install -D -m 0600 "$ENV_TMP" "$ENV_FILE"
  rm -f "$ENV_TMP"
  ok "Created ${ENV_FILE} (mode 0600) with a random EASY_MXL_TOKEN"
fi

# --- optional: hands-on tmpfs mount -----------------------------------------

if (( TMPFS_VOLUMES )); then
  info "Setting up the hands-on tmpfs mount at ${TMPFS_MOUNTPOINT}"
  mkdir -p "$TMPFS_MOUNTPOINT"
  if grep -qsE "^[^#]*[[:space:]]${TMPFS_MOUNTPOINT}[[:space:]]" /etc/fstab; then
    ok "/etc/fstab already has an entry for ${TMPFS_MOUNTPOINT}"
  else
    printf '%s\n' "$TMPFS_FSTAB_LINE" >> /etc/fstab
    ok "Added to /etc/fstab: ${TMPFS_FSTAB_LINE}"
    if have_systemd; then
      systemctl daemon-reload
    fi
  fi
  if mountpoint -q "$TMPFS_MOUNTPOINT"; then
    ok "${TMPFS_MOUNTPOINT} is already mounted"
  else
    mount "$TMPFS_MOUNTPOINT"
    ok "${TMPFS_MOUNTPOINT} mounted ($(df -h --output=fstype,size "$TMPFS_MOUNTPOINT" | tail -1 | tr -s ' '))"
  fi
fi

# --- 6. Enable and start ----------------------------------------------------

SERVICE_STARTED=0
if have_systemd; then
  info "Enabling and starting the service"
  systemctl daemon-reload
  systemctl enable --quiet "$UNIT_NAME"
  systemctl restart "$UNIT_NAME"
  sleep 1
  if systemctl is-active --quiet "$UNIT_NAME"; then
    SERVICE_STARTED=1
    ok "easy-mxl is active"
  else
    warn "easy-mxl did not stay up. Inspect it with: journalctl -u easy-mxl -n 50 --no-pager"
  fi
else
  warn "systemd is not running (WSL without systemd, or a container). The unit was installed but not started.
         Start EASY MXL manually with:  cd ${INSTALL_DIR} && EASY_MXL_HOST=0.0.0.0 ${NODE_BIN} dist/bin/easy-mxl.js
         On WSL, enable systemd by adding '[boot]' and 'systemd=true' to /etc/wsl.conf and running 'wsl --shutdown'."
fi

# --- summary ----------------------------------------------------------------

PORT=$(grep -E '^[[:space:]]*EASY_MXL_PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]' || true)
PORT=${PORT:-9700}
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)

printf '\n%s============================================================%s\n' "$C_OK" "$C_OFF"
printf 'EASY MXL is installed in %s\n\n' "$INSTALL_DIR"
printf '  Local URL:    http://localhost:%s/\n' "$PORT"
if [[ -n $HOST_IP ]]; then
  printf '  Network URL:  http://%s:%s/\n' "$HOST_IP" "$PORT"
fi
if [[ -n $GENERATED_TOKEN ]]; then
  printf '\n  API token (shown once, stored in %s):\n\n      %s\n\n' "$ENV_FILE" "$GENERATED_TOKEN"
  printf '  The web UI asks for it on first use. For curl:  -H "Authorization: Bearer <token>"\n'
else
  printf '\n  Token: see EASY_MXL_TOKEN in %s\n' "$ENV_FILE"
fi
printf '\n  Configuration:  %s  (then: systemctl restart easy-mxl)\n' "$ENV_FILE"
printf '  Status / logs:  systemctl status easy-mxl   |   journalctl -u easy-mxl -f\n'
if (( TMPFS_VOLUMES )); then
  printf '\n  To keep domains under %s (hands-on layout) instead of /dev/shm/mxl, add\n' "$TMPFS_MOUNTPOINT"
  printf '      EASY_MXL_DOMAIN_ROOT=%s\n' "$TMPFS_MOUNTPOINT"
  printf '  to %s and run: systemctl restart easy-mxl\n' "$ENV_FILE"
fi
if (( ! SERVICE_STARTED )) && have_systemd; then
  printf '\n  The service is not running yet - check: journalctl -u easy-mxl -n 50 --no-pager\n'
fi
printf '%s============================================================%s\n' "$C_OK" "$C_OFF"
