#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.lantor-dev-logs"
mkdir -p "$LOG_DIR"

STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/keepalive-$STAMP.log"
STOP_FILE="$LOG_DIR/keepalive.stop"
rm -f "$STOP_FILE"

log() {
  printf '[lantor-dev-keepalive] %s\n' "$*" | tee -a "$LOG_FILE"
}

status_snapshot() {
  {
    printf '\n--- status %s ---\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    ps -axo pid,ppid,pgid,stat,etime,command \
      | grep -E "$ROOT_DIR| target/debug/lantor|codex app-server --listen stdio" \
      | grep -v grep || true
    printf '\n--- ports ---\n'
    lsof -nP -iTCP:5173 -sTCP:LISTEN || true
    lsof -nP -iTCP:8787 -sTCP:LISTEN || true
  } >>"$LOG_FILE" 2>&1
}

on_signal() {
  local signal="$1"
  log "received $signal; stopping keepalive after current child exits"
  touch "$STOP_FILE"
}

trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'on_signal HUP' HUP

log "repo: $ROOT_DIR"
log "log: $LOG_FILE"
log "create $STOP_FILE to stop after the current run"

cd "$ROOT_DIR"
attempt=0
while [[ ! -f "$STOP_FILE" ]]; do
  attempt=$((attempt + 1))
  log "starting tauri dev attempt $attempt"
  status_snapshot
  npm run tauri:dev >>"$LOG_FILE" 2>&1
  exit_code=$?
  status_snapshot

  if (( exit_code >= 128 )); then
    signal=$((exit_code - 128))
    log "tauri dev exited after signal $signal (exit code $exit_code)"
  else
    log "tauri dev exited with code $exit_code"
  fi

  if [[ -f "$STOP_FILE" ]]; then
    break
  fi
  log "restarting in 2 seconds"
  sleep 2
done

log "keepalive stopped"
