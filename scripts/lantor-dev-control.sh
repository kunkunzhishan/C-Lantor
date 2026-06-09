#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-restart}"
CURRENT_PGID="$(ps -o pgid= -p $$ | tr -d ' ')"
DEFAULT_DB="$HOME/Library/Application Support/Lantor/lantor.sqlite"

sqlite_path_from_url() {
  local value="${LANTOR_DATABASE_URL:-}"
  if [[ -z "$value" ]]; then
    printf '%s\n' "$DEFAULT_DB"
    return
  fi
  case "$value" in
    sqlite://~/*) printf '%s/%s\n' "$HOME" "${value#sqlite://~/}" ;;
    sqlite:~/*) printf '%s/%s\n' "$HOME" "${value#sqlite:~/}" ;;
    sqlite://*) printf '%s\n' "${value#sqlite://}" ;;
    sqlite:*) printf '%s\n' "${value#sqlite:}" ;;
    *) printf '%s\n' "$DEFAULT_DB" ;;
  esac
}

DB_PATH="$(sqlite_path_from_url)"

log() {
  printf '[lantor-dev] %s\n' "$*"
}

process_exists() {
  ps -p "$1" >/dev/null 2>&1
}

pgid_for_pid() {
  ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '
}

kill_pgid() {
  local pgid="$1"
  local signal="${2:-TERM}"
  if [[ -z "$pgid" || "$pgid" == "$CURRENT_PGID" ]]; then
    return
  fi
  if ps -axo pgid= | tr -d ' ' | grep -qx "$pgid"; then
    log "sending $signal to process group $pgid"
    kill "-$signal" "-$pgid" 2>/dev/null || true
  fi
}

kill_pid_group() {
  local pid="$1"
  local signal="${2:-TERM}"
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    return
  fi
  if ! process_exists "$pid"; then
    return
  fi
  local pgid
  pgid="$(pgid_for_pid "$pid")"
  if [[ -n "$pgid" ]]; then
    kill_pgid "$pgid" "$signal"
  fi
}

dev_pgids() {
  ps -axo pid=,ppid=,pgid=,command= | while read -r pid ppid pgid command; do
    if [[ -z "${pgid:-}" || "${pgid}" == "$CURRENT_PGID" ]]; then
      continue
    fi
    if [[ "$command" == *"$ROOT_DIR"* ]]; then
      case "$command" in
        *"npm run tauri:dev"*|*"node "*"tauri dev"*|*"node "*"vite --host 127.0.0.1"*|*"target/debug/lantor"*|*"src-tauri/target/debug/lantor"*)
          printf '%s\n' "$pgid"
          ;;
      esac
    fi
    if [[ "$command" == *"codexloop.js"* && "$command" == *"--agent-context-tool long-task-event"* ]]; then
      printf '%s\n' "$pgid"
    fi
  done | sort -u
}

db_active_pids() {
  if [[ ! -f "$DB_PATH" ]] || ! command -v sqlite3 >/dev/null 2>&1; then
    return
  fi
  sqlite3 "$DB_PATH" "
    select pid from agent_runs where pid is not null and status in ('starting','running','stopping')
    union
    select pid from supervisor_state where pid is not null;
  " 2>/dev/null | awk '/^[0-9]+$/ {print}' | sort -u
}

active_agent_runs() {
  if [[ ! -f "$DB_PATH" ]] || ! command -v sqlite3 >/dev/null 2>&1; then
    return
  fi
  sqlite3 "$DB_PATH" "
    select
      coalesce(a.handle, hex(r.agent_id)) || ' run=' || lower(hex(r.id)) ||
      case when r.work_item_id is not null then ' work=' || lower(hex(r.work_item_id)) else '' end ||
      case when r.pid is not null then ' pid=' || r.pid else '' end ||
      ' status=' || r.status
    from agent_runs r
    left join agents a on a.id = r.agent_id
    where r.stopped_at is null
      and r.status in ('starting','running','stopping')
    order by r.started_at asc;
  " 2>/dev/null
}

guard_no_active_agent_runs() {
  local active
  active="$(active_agent_runs || true)"
  if [[ -z "$active" || "${LANTOR_FORCE_RESTART:-}" == "1" ]]; then
    if [[ -n "$active" && "${LANTOR_FORCE_RESTART:-}" == "1" ]]; then
      log "LANTOR_FORCE_RESTART=1 set; restarting despite active agent runs:"
      printf '%s\n' "$active" >&2
    fi
    return
  fi

  log "refusing restart because active agent runs would be orphaned:"
  printf '%s\n' "$active" >&2
  log "wait for them to finish, cancel them first, or rerun with LANTOR_FORCE_RESTART=1"
  exit 3
}

stop_lantor_dev() {
  log "repo: $ROOT_DIR"
  log "database: $DB_PATH"

  local pgids
  pgids="$(dev_pgids || true)"
  if [[ -n "$pgids" ]]; then
    while IFS= read -r pgid; do
      kill_pgid "$pgid" TERM
    done <<< "$pgids"
  else
    log "no Lantor dev process group found"
  fi

  local pids
  pids="$(db_active_pids || true)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      kill_pid_group "$pid" TERM
    done <<< "$pids"
  fi

  sleep 2

  pgids="$(dev_pgids || true)"
  if [[ -n "$pgids" ]]; then
    while IFS= read -r pgid; do
      kill_pgid "$pgid" KILL
    done <<< "$pgids"
  fi

  pids="$(db_active_pids || true)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      kill_pid_group "$pid" KILL
    done <<< "$pids"
  fi

  log "stop complete"
}

status_lantor_dev() {
  log "repo: $ROOT_DIR"
  ps -axo pid,ppid,pgid,stat,etime,command | while IFS= read -r line; do
    case "$line" in
      *"$ROOT_DIR"*|*" target/debug/lantor"*|*"codex app-server --listen stdio"*|*"codexloop.js"*"--agent-context-tool long-task-event"*)
        printf '%s\n' "$line"
        ;;
    esac
  done
}

case "$MODE" in
  stop)
    stop_lantor_dev
    ;;
  status)
    status_lantor_dev
    ;;
  restart)
    guard_no_active_agent_runs
    stop_lantor_dev
    log "starting npm run tauri:dev"
    cd "$ROOT_DIR"
    exec npm run tauri:dev
    ;;
  *)
    printf 'Usage: %s [stop|restart|status]\n' "$0" >&2
    exit 2
    ;;
esac
