#!/bin/bash

# Claude Memory Daemon — SessionStart Hook
# Injected on: startup, resume, /clear, compact

PROJECT_DIR="$(pwd)"

# 1. Inject observations
if [ -f "$PROJECT_DIR/OBSERVATIONS.md" ]; then
  cat "$PROJECT_DIR/OBSERVATIONS.md"
else
  echo "No observations yet. This is a fresh project with no observational memory built up."
fi

# 2. Daemon health check
if ! pgrep -f "claude-memory-daemon" > /dev/null 2>&1; then
  echo ""
  echo "⚠️  CLAUDE MEMORY DAEMON IS NOT RUNNING."
  echo "Observations from this session will NOT be captured."
  echo "Start it with: claude-memory start"
fi

# 3. Staleness check
if [ -f "$PROJECT_DIR/OBSERVATIONS.md" ]; then
  # Cross-platform stat: try GNU stat first, fall back to BSD
  OBS_MTIME=$(stat -c %Y "$PROJECT_DIR/OBSERVATIONS.md" 2>/dev/null || stat -f %m "$PROJECT_DIR/OBSERVATIONS.md" 2>/dev/null || echo 0)
  OBS_AGE=$(( $(date +%s) - OBS_MTIME ))
  if [ "$OBS_AGE" -gt 604800 ]; then
    echo ""
    echo "⚠️  Observations file is over 7 days old. The daemon may have stopped, errored, or this project has not been worked on for a while."
  fi
fi
