#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.lantor-dev-logs"
mkdir -p "$LOG_DIR"

STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/tauri-dev-$STAMP.log"
EXIT_REPORTED=0

log() {
  printf '[lantor-dev-debug] %s\n' "$*"
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
  log "received $signal; writing snapshot to $LOG_FILE"
  status_snapshot
}

trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'on_signal HUP' HUP
trap 'if [[ "$EXIT_REPORTED" != "1" ]]; then log "debug wrapper exiting without child exit report; writing snapshot to $LOG_FILE"; status_snapshot; fi' EXIT

log "repo: $ROOT_DIR"
log "log: $LOG_FILE"
cd "$ROOT_DIR"

status_snapshot
set -o pipefail
npm run tauri:dev 2>&1 | tee -a "$LOG_FILE"
exit_code=${PIPESTATUS[0]}
status_snapshot

if (( exit_code >= 128 )); then
  signal=$((exit_code - 128))
  log "tauri dev exited after signal $signal (exit code $exit_code); see $LOG_FILE"
else
  log "tauri dev exited with code $exit_code; see $LOG_FILE"
fi
EXIT_REPORTED=1
exit "$exit_code"
