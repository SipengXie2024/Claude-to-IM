#!/usr/bin/env bash
# Linux supervisor — setsid/nohup fallback process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  # Launch a wrapper loop that auto-restarts the daemon on exit.
  # - Normal exit (0) from SIGUSR2 graceful restart → restart after 1s
  # - Crash exit (non-zero) → restart after 3s (with max 5 rapid restarts)
  # - SIGTERM/SIGINT (stop) → the loop exits because PID_FILE is removed by supervisor_stop
  local wrapper
  wrapper='
    RAPID_COUNT=0
    while true; do
      node "'"$SKILL_DIR"'/dist/daemon.mjs"
      EXIT_CODE=$?
      # If PID file was removed, daemon.sh stop was called — exit the loop
      [ ! -f "'"$PID_FILE"'" ] && break
      if [ "$EXIT_CODE" -eq 0 ]; then
        echo "[supervisor] Daemon exited cleanly (code 0), restarting in 1s..."
        RAPID_COUNT=0
        sleep 1
      else
        RAPID_COUNT=$((RAPID_COUNT + 1))
        if [ "$RAPID_COUNT" -ge 5 ]; then
          echo "[supervisor] Daemon crashed 5 times in a row (exit $EXIT_CODE), giving up"
          break
        fi
        echo "[supervisor] Daemon crashed (exit $EXIT_CODE, count $RAPID_COUNT/5), restarting in 3s..."
        sleep 3
      fi
    done
  '
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "$wrapper" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup bash -c "$wrapper" >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  # Write wrapper PID; main.ts will overwrite with the actual node PID
  echo $! > "$PID_FILE"
}

supervisor_stop() {
  local pid
  pid=$(read_pid)
  # Remove PID file FIRST — this signals the wrapper loop to exit after the process ends
  rm -f "$PID_FILE"
  if [ -z "$pid" ]; then echo "No bridge running"; return 0; fi
  if pid_alive "$pid"; then
    kill "$pid"
    for _ in $(seq 1 10); do
      pid_alive "$pid" || break
      sleep 1
    done
    pid_alive "$pid" && kill -9 "$pid"
    echo "Bridge stopped"
  else
    echo "Bridge was not running (stale PID file)"
  fi
}

supervisor_is_managed() {
  # Linux fallback has no service manager; always false
  return 1
}

supervisor_status_extra() {
  # No extra status for Linux fallback
  :
}

supervisor_is_running() {
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
