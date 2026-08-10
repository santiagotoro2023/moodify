#!/usr/bin/env bash
# Moodify uninstaller. Interactive, because it can destroy data.
set -euo pipefail

INSTALL_DIR="${MOODIFY_INSTALL_DIR:-/opt/moodify}"
[ -f "$INSTALL_DIR/docker-compose.yml" ] || INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

SUDO=''
[ "$(id -u)" -ne 0 ] && SUDO='sudo'

# Default No: preserving data is the safe answer for the common "reinstall later" case.
ask() {
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

cd "$INSTALL_DIR"
say "Stopping Moodify containers..."
$SUDO docker compose down

if ask "Also delete the database and all uploaded assets? This is irreversible."; then
  say "Removing volumes..."
  $SUDO docker compose down -v
  $SUDO docker volume rm -f moodify_moodify-db moodify_moodify-assets 2>/dev/null || true
else
  say "Volumes preserved. Re-running install.sh will pick up where you left off."
fi

if ask "Remove the install directory ${INSTALL_DIR}?"; then
  # .env holds ENCRYPTION_KEY; without it a preserved database cannot decrypt its Moodle token.
  say "Note: this deletes .env, including the key that decrypts the stored Moodle token."
  if ask "Really delete ${INSTALL_DIR}?"; then
    cd /
    $SUDO rm -rf "$INSTALL_DIR"
    say "Removed."
  fi
fi

say "Done."
