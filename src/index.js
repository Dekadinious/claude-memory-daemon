#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import config from './config.js';
import { startWatching } from './watcher.js';
import { initProject } from './init.js';
import { loadState, saveState, updateFileOffset } from './state.js';

const args = process.argv.slice(2);
const command = args[0];

// Package root directory (where the git repo lives)
const PACKAGE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Ensure claude CLI is available
function checkClaude() {
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    console.error('Error: claude CLI not found in PATH.');
    console.error('Install Claude Code: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }
}

function loadProjects() {
  try {
    const data = JSON.parse(fs.readFileSync(config.PROJECTS_FILE, 'utf-8'));
    return data.projects || [];
  } catch {
    return [];
  }
}

function isRunning() {
  try {
    const pid = parseInt(fs.readFileSync(config.PID_FILE, 'utf-8').trim());
    process.kill(pid, 0); // Signal 0 = check if alive
    return pid;
  } catch {
    // PID file doesn't exist or process is dead
    try { fs.unlinkSync(config.PID_FILE); } catch {}
    return false;
  }
}

/**
 * Find all daemon processes via pgrep (catches strays not tracked by PID file).
 * Returns array of PIDs, excluding the current process.
 */
function findAllDaemons() {
  try {
    const output = execSync('pgrep -f "claude-memory-daemon.*_daemon"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n')
      .map(p => parseInt(p.trim()))
      .filter(p => !isNaN(p) && p !== process.pid);
  } catch {
    return []; // No matches
  }
}

/**
 * Kill all existing daemon processes and clean up PID file.
 * Used on startup to guarantee a single instance.
 */
/**
 * Check if the systemd user service is installed and what state it's in.
 * Returns 'active', 'inactive', 'failed', etc., or null if the service
 * unit is not installed (or systemd is not available).
 */
function serviceStatus() {
  try {
    // LoadState always exits 0 — returns 'loaded' or 'not-found'
    const loadState = execSync(
      'systemctl --user show claude-memory.service --property=LoadState --value',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (loadState !== 'loaded') {
      return null; // Unit file does not exist
    }

    // ActiveState also always exits 0
    const activeState = execSync(
      'systemctl --user show claude-memory.service --property=ActiveState --value',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    return activeState; // 'active', 'inactive', 'failed', etc.
  } catch {
    return null; // systemctl not available (non-systemd system)
  }
}

function killAllDaemons() {
  const pids = findAllDaemons();
  if (pids.length > 0) {
    // SIGTERM first, then verify and SIGKILL any survivors
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    // Brief wait for graceful shutdown
    try { execSync('sleep 0.5', { stdio: 'pipe' }); } catch {}
    for (const pid of pids) {
      try {
        process.kill(pid, 0); // Still alive?
        process.kill(pid, 'SIGKILL');
        console.log(`Force-killed stale daemon (PID: ${pid})`);
      } catch {
        console.log(`Killed stale daemon (PID: ${pid})`);
      }
    }
  }
  try { fs.unlinkSync(config.PID_FILE); } catch {}
}

/**
 * Check if there are updates available on the remote.
 * Returns { behind: number, current: string, remote: string } or null on error.
 */
function checkForUpdates() {
  try {
    execSync('git fetch --quiet', { cwd: PACKAGE_DIR, stdio: 'pipe', timeout: 10_000 });
    const local = execSync('git rev-parse HEAD', { cwd: PACKAGE_DIR, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const remote = execSync('git rev-parse @{u}', { cwd: PACKAGE_DIR, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (local === remote) return { behind: 0, current: local.slice(0, 7), remote: remote.slice(0, 7) };
    const behind = parseInt(
      execSync(`git rev-list --count HEAD..@{u}`, { cwd: PACKAGE_DIR, encoding: 'utf-8', stdio: 'pipe' }).trim()
    );
    return { behind, current: local.slice(0, 7), remote: remote.slice(0, 7) };
  } catch {
    return null;
  }
}

function daemonMain() {
  // Verify claude CLI is available (needed for Observer/Reflector passes)
  checkClaude();

  // Write PID
  fs.mkdirSync(config.DAEMON_DIR, { recursive: true });
  fs.writeFileSync(config.PID_FILE, String(process.pid));

  console.log(`[Daemon] Started (PID: ${process.pid})`);

  const projects = loadProjects();
  if (projects.length === 0) {
    console.log('[Daemon] No projects registered. Use "claude-memory init" in a project directory.');
    console.log('[Daemon] Waiting for projects...');
  }

  // Validate project paths
  const validProjects = projects.filter(p => {
    if (!fs.existsSync(p.path)) {
      console.warn(`[Daemon] Project path not found: ${p.path} — skipping`);
      return false;
    }
    return true;
  });

  startWatching(validProjects);

  // Keep the process alive even when there are no active watchers
  setInterval(() => {}, 60_000);

  // Handle shutdown
  const cleanup = () => {
    console.log('[Daemon] Shutting down...');
    try { fs.unlinkSync(config.PID_FILE); } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('uncaughtException', (err) => {
    console.error('[Daemon] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[Daemon] Unhandled rejection:', err);
  });
}

// CLI commands
switch (command) {
  case 'start': {
    checkClaude();

    // If systemd service is installed, always use that (avoids fighting with systemd)
    const svcStatus = serviceStatus();
    if (svcStatus !== null) {
      if (svcStatus === 'active') {
        console.log('Daemon is already running via systemd service.');
        process.exit(0);
      }
      try {
        execSync('systemctl --user restart claude-memory', { stdio: 'inherit' });
        console.log('Daemon started via systemd service.');
      } catch (err) {
        console.error('Failed to start systemd service:', err.message);
        console.log('Try: systemctl --user status claude-memory');
      }
      process.exit(0);
    }

    // No systemd service — manual mode: kill strays and spawn
    killAllDaemons();

    fs.mkdirSync(config.DAEMON_DIR, { recursive: true });
    const logStream = fs.openSync(config.LOG_FILE, 'a');
    const child = spawn(process.execPath, [path.resolve(new URL(import.meta.url).pathname), '_daemon'], {
      detached: true,
      stdio: ['ignore', logStream, logStream],
    });
    child.unref();

    // Wait briefly to verify it started
    setTimeout(() => {
      const newPid = isRunning();
      if (newPid) {
        console.log(`Daemon started (PID: ${newPid}).`);
        console.log(`Logs: ${config.LOG_FILE}`);
      } else {
        console.error('Daemon failed to start. Check logs:', config.LOG_FILE);
      }
      process.exit(0);
    }, 500);
    break;
  }

  case '_daemon': {
    // Internal: actual daemon process
    daemonMain();
    break;
  }

  case 'stop': {
    const svcStatus = serviceStatus();
    if (svcStatus === 'active') {
      try {
        execSync('systemctl --user stop claude-memory', { stdio: 'inherit' });
        console.log('Daemon stopped (systemd service).');
      } catch (err) {
        console.error('Failed to stop systemd service:', err.message);
      }
      break;
    }

    const pid = isRunning();
    if (!pid) {
      console.log('Daemon is not running.');
      process.exit(0);
    }
    process.kill(pid, 'SIGTERM');
    console.log(`Daemon stopped (PID: ${pid}).`);
    break;
  }

  case 'status': {
    const svcStatus = serviceStatus();
    const pid = isRunning();
    if (svcStatus === 'active') {
      console.log(`Daemon: running via systemd`);
    } else if (pid) {
      console.log(`Daemon: running (PID: ${pid})`);
    } else {
      console.log('Daemon: not running');
    }

    const projects = loadProjects();
    if (projects.length === 0) {
      console.log('Projects: none registered');
    } else {
      console.log(`\nProjects (${projects.length}):`);
      for (const p of projects) {
        const state = loadState(p.path);
        const fileCount = Object.keys(state.files).length;
        const obsPath = path.join(p.path, config.OBSERVATIONS_FILE);
        let obsSize = 0;
        try { obsSize = fs.statSync(obsPath).size; } catch {}
        console.log(`  ${p.path}`);
        console.log(`    Files processed: ${fileCount} | Observer passes: ${state.totalObserverPasses} | Reflector passes: ${state.totalReflectorPasses}`);
        console.log(`    Observations: ${(obsSize / 1024).toFixed(1)}KB (~${Math.round(obsSize / 4)} tokens)`);
      }
    }

    // Update check (non-blocking, silent on error)
    const updateInfo = checkForUpdates();
    if (updateInfo && updateInfo.behind > 0) {
      console.log(`\nUpdate available: ${updateInfo.behind} new commit(s) (${updateInfo.current} → ${updateInfo.remote})`);
      console.log('Run: claude-memory update');
    }
    break;
  }

  case 'list': {
    const projects = loadProjects();
    if (projects.length === 0) {
      console.log('No projects registered.');
    } else {
      for (const p of projects) {
        console.log(`  ${p.path} (registered ${p.registeredAt})`);
      }
    }
    break;
  }

  case 'remove': {
    const target = args[1] || process.cwd();
    const resolved = path.resolve(target);

    let data = { projects: [] };
    try { data = JSON.parse(fs.readFileSync(config.PROJECTS_FILE, 'utf-8')); } catch {}

    const before = data.projects.length;
    data.projects = data.projects.filter(p => p.path !== resolved);

    if (data.projects.length === before) {
      console.log(`Project not found: ${resolved}`);
    } else {
      fs.writeFileSync(config.PROJECTS_FILE, JSON.stringify(data, null, 2));
      console.log(`Removed: ${resolved}`);
      console.log('Note: OBSERVATIONS.md was not deleted. Restart daemon to apply.');
    }
    break;
  }

  case 'logs': {
    try {
      execSync(`tail -f "${config.LOG_FILE}"`, { stdio: 'inherit' });
    } catch {
      // User pressed Ctrl+C
    }
    break;
  }

  case 'init': {
    const noCatchup = args.includes('--no-catchup');
    const projectPath = path.resolve(args.find(a => a !== 'init' && !a.startsWith('-')) || process.cwd());
    if (noCatchup) {
      console.log('Note: --no-catchup set. Existing conversations will NOT be processed.');
      console.log('Only new conversations after this point will generate observations.\n');
    }
    initProject(projectPath, { noCatchup });
    break;
  }

  case 'config': {
    // Filter out --project and its value from args to find subcommand
    const configArgs = args.slice(1).filter((a, i, arr) => a !== '--project' && arr[i - 1] !== '--project');
    const subCmd = configArgs[0];
    const target = args.includes('--project')
      ? path.resolve(args[args.indexOf('--project') + 1])
      : path.resolve(process.cwd());

    let data = { projects: [] };
    try { data = JSON.parse(fs.readFileSync(config.PROJECTS_FILE, 'utf-8')); } catch {}

    const project = data.projects.find(p => p.path === target);
    if (!project) {
      console.error(`Project not registered: ${target}`);
      console.error('Run "claude-memory init" first, or use --project <path>.');
      process.exit(1);
    }

    if (subCmd === 'set') {
      const key = configArgs[1];
      const value = configArgs[2];

      if (key === 'reflector-threshold') {
        const num = parseInt(value);
        if (isNaN(num) || num < 1000) {
          console.error('Threshold must be a number >= 1000');
          process.exit(1);
        }
        project.reflectorThreshold = num;
        fs.writeFileSync(config.PROJECTS_FILE, JSON.stringify(data, null, 2));
        console.log(`Set reflector threshold to ${num} tokens for ${target}`);
      } else {
        console.error(`Unknown config key: ${key}`);
        console.log('Available keys: reflector-threshold');
      }
    } else if (subCmd === 'get' || !subCmd) {
      console.log(`Config for: ${target}`);
      console.log(`  reflector-threshold: ${project.reflectorThreshold || config.DEFAULT_REFLECTOR_THRESHOLD}`);
      console.log(`  claude-project-dir: ${project.claudeProjectDir}`);
      console.log(`  registered: ${project.registeredAt}`);
    } else {
      console.log('Usage: claude-memory config [get|set] [key] [value] [--project path]');
    }
    break;
  }

  case 'update': {
    console.log(`Package directory: ${PACKAGE_DIR}`);
    const info = checkForUpdates();
    if (!info) {
      console.error('Failed to check for updates (no git remote or network issue).');
      process.exit(1);
    }
    if (info.behind === 0) {
      console.log(`Already up to date (${info.current}).`);
      process.exit(0);
    }
    console.log(`${info.behind} new commit(s) available (${info.current} → ${info.remote}).`);
    console.log('Pulling...');
    try {
      execSync('git pull --ff-only', { cwd: PACKAGE_DIR, stdio: 'inherit', timeout: 30_000 });
    } catch (err) {
      console.error('git pull failed:', err.message);
      console.error('You may need to resolve conflicts manually.');
      process.exit(1);
    }

    // Reinstall dependencies if package.json changed
    try {
      const diff = execSync(`git diff HEAD~${info.behind} --name-only`, { cwd: PACKAGE_DIR, encoding: 'utf-8', stdio: 'pipe' });
      if (diff.includes('package.json') || diff.includes('package-lock.json')) {
        console.log('Dependencies changed, running npm install...');
        execSync('npm install', { cwd: PACKAGE_DIR, stdio: 'inherit' });
      }
    } catch {}

    // Restart daemon if running
    const svcStatus = serviceStatus();
    if (svcStatus === 'active') {
      console.log('Restarting daemon...');
      try {
        execSync('systemctl --user restart claude-memory', { stdio: 'inherit' });
        console.log('Daemon restarted.');
      } catch (err) {
        console.error('Failed to restart daemon:', err.message);
      }
    } else {
      const pid = isRunning();
      if (pid) {
        console.log('Restarting daemon...');
        process.kill(pid, 'SIGTERM');
        setTimeout(() => {
          const child = spawn(process.execPath, [path.resolve(new URL(import.meta.url).pathname), '_daemon'], {
            detached: true,
            stdio: ['ignore', fs.openSync(config.LOG_FILE, 'a'), fs.openSync(config.LOG_FILE, 'a')],
          });
          child.unref();
          console.log('Daemon restarted.');
        }, 1000);
      }
    }

    console.log('Update complete.');
    break;
  }

  case 'seal': {
    // Mark all untracked conversation files as "already read" for a project.
    // Use this when a project has already been initialized but you don't want
    // the daemon catching up on remaining historical conversations.
    const target = args[1] ? path.resolve(args[1]) : path.resolve(process.cwd());

    let data = { projects: [] };
    try { data = JSON.parse(fs.readFileSync(config.PROJECTS_FILE, 'utf-8')); } catch {}

    const project = data.projects.find(p => p.path === target);
    if (!project) {
      console.error(`Project not registered: ${target}`);
      console.error('Run "claude-memory init" first.');
      process.exit(1);
    }

    const claudeDir = path.join(config.CLAUDE_PROJECTS_DIR, project.claudeProjectDir);
    if (!fs.existsSync(claudeDir)) {
      console.error(`Claude project dir not found: ${claudeDir}`);
      process.exit(1);
    }

    const state = loadState(project.path);
    let sealed = 0;

    const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(claudeDir, file);
      const stat = fs.statSync(filePath);
      const currentOffset = state.files[file]?.offset || 0;
      if (stat.size > currentOffset) {
        updateFileOffset(state, file, stat.size, 0);
        sealed++;
      }
    }

    if (sealed > 0) {
      saveState(project.path, state);
      console.log(`Sealed ${sealed} unprocessed conversation(s) for: ${target}`);
      console.log('Daemon will now only process new content written after this point.');
    } else {
      console.log('All conversations already tracked. Nothing to seal.');
    }
    break;
  }

  case 'install-service': {
    const serviceDir = path.join(process.env.HOME, '.config', 'systemd', 'user');
    fs.mkdirSync(serviceDir, { recursive: true });

    const nodePath = process.execPath;
    const scriptPath = path.resolve(new URL(import.meta.url).pathname);

    const serviceContent = `[Unit]
Description=Claude Memory Daemon
After=default.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} _daemon
Restart=on-failure
RestartSec=10
Environment=PATH=${process.env.PATH}

[Install]
WantedBy=default.target
`;

    const servicePath = path.join(serviceDir, 'claude-memory.service');
    fs.writeFileSync(servicePath, serviceContent);

    try {
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
      execSync('systemctl --user enable claude-memory', { stdio: 'inherit' });
      execSync('systemctl --user start claude-memory', { stdio: 'inherit' });
      console.log('Service installed and started.');
      console.log('It will auto-start on login and restart on crash.');
    } catch (err) {
      console.error('Failed to set up systemd service:', err.message);
      console.log(`Service file written to: ${servicePath}`);
      console.log('Try manually: systemctl --user enable --now claude-memory');
    }
    break;
  }

  default: {
    console.log(`Usage: claude-memory <command>

Commands:
  init [path]              Initialize a project for observational memory
    --no-catchup             Skip processing existing conversations (saves tokens)
  start                    Start the daemon (background)
  stop                     Stop the daemon
  status                   Show daemon status and project info
  list                     List registered projects
  remove [path]            Unregister a project
  seal [path]              Mark all untracked conversations as read (stop catchup)
  config [get|set]         View or change project settings
    config                   Show current project config
    config set <key> <val>   Change a setting
    --project <path>         Target a specific project (default: cwd)
    Keys: reflector-threshold
  logs                     Tail daemon logs
  update                   Pull latest code from git and restart daemon
  install-service          Set up systemd user service (auto-start)
`);
    break;
  }
}
