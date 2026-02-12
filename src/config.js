import path from 'path';
import os from 'os';

const DAEMON_DIR = path.join(os.homedir(), '.claude-memory');

export default {
  // How long to wait after last file change before processing
  DEBOUNCE_MS: 5 * 60 * 1000, // 5 minutes per file

  // Max files to process on startup catchup (per project)
  MAX_CATCHUP_FILES: 10,

  // Token threshold to trigger Reflector consolidation
  DEFAULT_REFLECTOR_THRESHOLD: 20000,

  // Max chars for truncated tool results in parser
  MAX_TOOL_RESULT_CHARS: 500,

  // Minimum JSONL file size to process (skip trivial sessions)
  MIN_FILE_SIZE_BYTES: 1024,

  // Lock retry settings
  LOCK_RETRY_DELAY_MS: 5000,
  LOCK_MAX_RETRIES: 12, // 1 minute total

  // File names
  OBSERVATIONS_FILE: 'OBSERVATIONS.md',
  LOCK_FILE: '.claude/observations.lock',

  // Global paths
  DAEMON_DIR,
  PID_FILE: path.join(DAEMON_DIR, 'daemon.pid'),
  LOG_FILE: path.join(DAEMON_DIR, 'daemon.log'),
  PROJECTS_FILE: path.join(DAEMON_DIR, 'projects.json'),
  STATE_DIR: path.join(DAEMON_DIR, 'state'),

  // Claude Code conversation storage
  CLAUDE_PROJECTS_DIR: path.join(os.homedir(), '.claude', 'projects'),
};
