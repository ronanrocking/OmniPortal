#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="${1:-$HOME/OmniPortal}"
REPO_URL="${REPO_URL:-https://github.com/ronanrocking/OmniPortal.git}"
SKIP_GIT_UPDATE="${SKIP_GIT_UPDATE:-0}"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$1"
}

fail() {
  printf '\n[ERROR] %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

resolve_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    fail "Docker Compose is not installed."
  fi
}

check_docker_access() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi

  cat >&2 <<'EOF'

[ERROR] Docker is installed, but the current SSH user cannot access the Docker daemon.

Run this once on the Pi from an account that can use sudo:

  sudo usermod -aG docker codex

Then fully log out the codex SSH session and reconnect before retrying this script.
EOF
  exit 1
}

clone_or_update_repo() {
  if [ ! -d "$REPO_DIR/.git" ]; then
    log "Cloning repo into $REPO_DIR"
    git clone "$REPO_URL" "$REPO_DIR"
    return
  fi

  if [ "$SKIP_GIT_UPDATE" = "1" ]; then
    log "Skipping git update; using files already present in $REPO_DIR"
    return
  fi

  log "Updating repo in $REPO_DIR"
  git -C "$REPO_DIR" fetch origin
  git -C "$REPO_DIR" pull --ff-only origin main
}

wait_for_status() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl --silent --show-error --fail http://localhost:8000/status; then
      printf '\n'
      return 0
    fi
    sleep 2
  done

  return 1
}

main() {
  require_command git
  require_command docker
  require_command curl

  resolve_compose
  check_docker_access
  clone_or_update_repo

  cd "$REPO_DIR"

  log "Building backend image"
  "${COMPOSE_CMD[@]}" build backend

  log "Starting backend container"
  "${COMPOSE_CMD[@]}" up -d backend

  log "Checking /status endpoint"
  if wait_for_status; then
    log "Backend is healthy"
    return 0
  fi

  log "Backend did not become healthy; printing logs"
  "${COMPOSE_CMD[@]}" logs backend --tail 100
  fail "Backend failed health check."
}

main "$@"
