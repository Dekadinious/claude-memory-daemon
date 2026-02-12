import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';

function projectHash(projectPath) {
  return crypto.createHash('md5').update(projectPath).digest('hex').slice(0, 12);
}

function stateDir(projectPath) {
  return path.join(config.STATE_DIR, projectHash(projectPath));
}

function stateFile(projectPath) {
  return path.join(stateDir(projectPath), 'observer-state.json');
}

export function loadState(projectPath) {
  const file = stateFile(projectPath);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {
      files: {},
      lastReflection: null,
      totalObserverPasses: 0,
      totalReflectorPasses: 0,
    };
  }
}

export function saveState(projectPath, state) {
  const dir = stateDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(projectPath), JSON.stringify(state, null, 2));
}

export function getFileOffset(state, filename) {
  return state.files[filename]?.offset || 0;
}

export function updateFileOffset(state, filename, offset, observationCount = 0) {
  if (!state.files[filename]) {
    state.files[filename] = {};
  }
  state.files[filename].offset = offset;
  state.files[filename].lastProcessed = new Date().toISOString();
  state.files[filename].observationCount = (state.files[filename].observationCount || 0) + observationCount;
}
