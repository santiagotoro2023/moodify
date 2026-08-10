#!/usr/bin/env bash
# Moodify installer. Idempotent — safe to re-run on an existing install.
# This is the only command you ever need to type; everything else is in the browser.
set -euo pipefail

INSTALL_DIR="${MOODIFY_INSTALL_DIR:-/opt/moodify}"
REPO_URL="${MOODIFY_REPO_URL:-https://github.com/santiagotoro2023/moodify.git}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=''
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "Not root and sudo is not installed."
  SUDO='sudo'
fi

# --- 1. OS check ------------------------------------------------------------
[ -r /etc/os-release ] || die "Cannot read /etc/os-release; this installer targets Debian."
. /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in
  debian:*|*:*debian*) : ;;
  *) die "Moodify targets Debian. Detected '${PRETTY_NAME:-unknown}'. Aborting." ;;
esac
[ "${ID:-}" = "ubuntu" ] && warn "Ubuntu detected. Debian-based, so this should work, but it is untested."
say "OS: ${PRETTY_NAME:-Debian}"

# --- 2. Docker --------------------------------------------------------------
if docker compose version >/dev/null 2>&1; then
  say "Docker and the Compose plugin are already installed."
else
  say "Installing Docker from the official Docker apt repository..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ca-certificates curl gnupg
  $SUDO install -m 0755 -d /etc/apt/keyrings
  if [ ! -s /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
      | $SUDO tee /etc/apt/keyrings/docker.asc >/dev/null
    $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin \
    || die "Docker install from the official repository failed. Stopping here rather than guessing at a fallback — please report this."
  $SUDO systemctl enable --now docker
  say "Docker installed."
fi

# --- 3. Install directory ---------------------------------------------------
if [ "$SRC_DIR" != "$INSTALL_DIR" ]; then
  say "Installing to ${INSTALL_DIR}"
  $SUDO mkdir -p "$INSTALL_DIR"
  if [ -f "$SRC_DIR/docker-compose.yml" ]; then
    $SUDO cp -r "$SRC_DIR/." "$INSTALL_DIR/"
  elif [ -d "$INSTALL_DIR/.git" ]; then
    $SUDO git -C "$INSTALL_DIR" pull --ff-only
  else
    command -v git >/dev/null || $SUDO apt-get install -y -qq git
    $SUDO git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
fi
cd "$INSTALL_DIR"

# --- 4. Secrets -------------------------------------------------------------
# Never regenerated: rotating ENCRYPTION_KEY would orphan the stored Moodle token.
if [ -f .env ]; then
  say "Keeping existing .env (secrets left untouched)."
else
  say "Generating .env with fresh random secrets..."
  $SUDO tee .env >/dev/null <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
MOODIFY_PORT=${MOODIFY_PORT:-8080}
EOF
  $SUDO chmod 600 .env
fi

# --- 5. Start ---------------------------------------------------------------
say "Building and starting containers (first run pulls images, this takes a few minutes)..."
$SUDO docker compose up -d --build

PORT="$(grep -E '^MOODIFY_PORT=' .env | cut -d= -f2)"
PORT="${PORT:-8080}"

say "Waiting for Moodify to become healthy..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    printf '\n\033[1;32m  Moodify is up.\033[0m\n\n'
    printf '  Open  \033[1mhttp://%s:%s\033[0m  to run the setup wizard.\n\n' "${IP:-localhost}" "$PORT"
    printf '  That was the only command you need. Everything else — Moodle connection,\n'
    printf '  dashboards, users, settings — is configured in the browser.\n\n'
    exit 0
  fi
  sleep 3
done

warn "Moodify did not report healthy within 3 minutes. Recent logs:"
$SUDO docker compose logs --tail 60 app
exit 1
