import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { parseConversationDelta } from './parser.js';
import { runObserver, appendObservations, exceedsThreshold } from './observer.js';
import { runReflector } from './reflector.js';
import { autoCommitObservations } from './git.js';
import { loadState, saveState, getFileOffset, updateFileOffset } from './state.js';

const debounceTimers = new Map();
const processingQueue = new Map(); // prevent concurrent processing per project
const activeWatchers = new Map(); // track watchers by project path

/**
 * Start watching all registered projects and watch projects.json for changes.
 */
export function startWatching(projects) {
  console.log(`[Watcher] Starting watch on ${projects.length} project(s)`);

  for (const project of projects) {
    watchProject(project);
  }

  // Watch projects.json for new registrations
  watchProjectsConfig();
}

function watchProject(project) {
  // Skip if already watching this project
  if (activeWatchers.has(project.path)) {
    return;
  }

  const claudeDir = path.join(config.CLAUDE_PROJECTS_DIR, project.claudeProjectDir);

  if (!fs.existsSync(claudeDir)) {
    console.warn(`[Watcher] Claude project dir not found: ${claudeDir} — skipping (will retry on config change)`);
    return;
  }

  // Startup catchup (skip if configured)
  const catchupDone = project.skipCatchup
    ? Promise.resolve((() => { console.log(`[Catchup] ${project.path}: skipped (--no-catchup)`); })())
    : catchupProject(project);

  catchupDone.then(() => {
    // Then start watching for new changes
    const watcher = chokidar.watch(path.join(claudeDir, '*.jsonl'), {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
    });

    watcher.on('change', (filePath) => {
      debounceFile(filePath, project);
    });

    watcher.on('add', (filePath) => {
      debounceFile(filePath, project);
    });

    activeWatchers.set(project.path, watcher);
    console.log(`[Watcher] Watching ${claudeDir}`);
  });
}

/**
 * Watch projects.json for changes — pick up new projects without restart.
 */
function watchProjectsConfig() {
  if (!fs.existsSync(config.PROJECTS_FILE)) return;

  const configWatcher = chokidar.watch(config.PROJECTS_FILE, {
    persistent: true,
    ignoreInitial: true,
  });

  configWatcher.on('change', () => {
    console.log('[Watcher] projects.json changed, checking for new projects...');
    try {
      const data = JSON.parse(fs.readFileSync(config.PROJECTS_FILE, 'utf-8'));
      const projects = data.projects || [];

      for (const project of projects) {
        if (!activeWatchers.has(project.path) && fs.existsSync(project.path)) {
          console.log(`[Watcher] New project detected: ${project.path}`);
          watchProject(project);
        }
      }
    } catch (err) {
      console.error('[Watcher] Failed to reload projects.json:', err.message);
    }
  });
}

function debounceFile(filePath, project) {
  const key = filePath;

  if (debounceTimers.has(key)) {
    clearTimeout(debounceTimers.get(key));
  }

  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);

    // Verify project directory still exists before processing
    if (!fs.existsSync(project.path)) {
      console.warn(`[Watcher] Project path gone: ${project.path} — skipping ${path.basename(filePath)}`);
      return;
    }

    processFile(filePath, project).catch(err => {
      console.error(`[Watcher] Error processing ${path.basename(filePath)}:`, err.message);
    });
  }, config.DEBOUNCE_MS));

  console.log(`[Watcher] Debounced: ${path.basename(filePath)} (${config.DEBOUNCE_MS / 1000}s timer)`);
}

async function catchupProject(project) {
  const claudeDir = path.join(config.CLAUDE_PROJECTS_DIR, project.claudeProjectDir);
  const state = loadState(project.path);

  let files;
  try {
    files = fs.readdirSync(claudeDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: path.join(claudeDir, f),
        stat: fs.statSync(path.join(claudeDir, f)),
      }))
      .filter(f => f.stat.size >= config.MIN_FILE_SIZE_BYTES)
      .filter(f => {
        const offset = getFileOffset(state, f.name);
        return f.stat.size > offset;
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, config.MAX_CATCHUP_FILES);
  } catch (err) {
    console.error(`[Catchup] Failed to read ${claudeDir}:`, err.message);
    return;
  }

  if (files.length === 0) {
    console.log(`[Catchup] ${project.path}: no unprocessed files`);
    return;
  }

  console.log(`[Catchup] ${project.path}: processing ${files.length} file(s)`);

  for (const file of files) {
    await processFile(file.path, project);
  }
}

async function processFile(filePath, project) {
  const fileName = path.basename(filePath);
  const projectKey = project.path;

  // Prevent concurrent processing of same project
  if (processingQueue.get(projectKey)) {
    console.log(`[Watcher] Already processing ${projectKey}, skipping ${fileName}`);
    return;
  }
  processingQueue.set(projectKey, true);

  try {
    // Check file still exists and meets minimum size
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return; // File was deleted
    }

    if (stat.size < config.MIN_FILE_SIZE_BYTES) {
      return;
    }

    const state = loadState(project.path);
    const offset = getFileOffset(state, fileName);

    if (stat.size <= offset) {
      return; // Already processed up to this point
    }

    console.log(`[Observer] Processing ${fileName} (offset ${offset} → ${stat.size})`);

    // Parse the delta
    const { text, newOffset } = parseConversationDelta(filePath, offset);

    if (!text || text.trim().length < 100) {
      // Too little content to be meaningful
      updateFileOffset(state, fileName, newOffset, 0);
      saveState(project.path, state);
      return;
    }

    // Run Observer
    const observations = runObserver(text);

    if (observations) {
      // Extract session ID from filename (first part before any dash)
      const sessionId = fileName.replace('.jsonl', '').slice(0, 8);

      const appended = await appendObservations(project.path, observations, sessionId);

      if (appended) {
        state.totalObserverPasses++;
        console.log(`[Observer] Appended observations for ${fileName}`);

        // Auto-commit
        autoCommitObservations(project.path);

        // Check if Reflector needed
        const threshold = project.reflectorThreshold || config.DEFAULT_REFLECTOR_THRESHOLD;
        if (exceedsThreshold(project.path, threshold)) {
          console.log(`[Reflector] Threshold exceeded, consolidating...`);
          const reflected = await runReflector(project.path);
          if (reflected) {
            state.totalReflectorPasses++;
            state.lastReflection = new Date().toISOString();
            autoCommitObservations(project.path);
          }
        }
      }
    } else {
      console.log(`[Observer] No observations for ${fileName}`);
    }

    updateFileOffset(state, fileName, newOffset, observations ? 1 : 0);
    saveState(project.path, state);
  } finally {
    processingQueue.set(projectKey, false);
  }
}
