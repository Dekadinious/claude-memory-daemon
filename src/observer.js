import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBSERVER_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'observer.md');

/**
 * Run the Observer pass on a conversation delta.
 * Returns the observations text, or null if NO_OBSERVATIONS.
 */
export function runObserver(conversationText) {
  if (!conversationText || conversationText.trim().length === 0) {
    return null;
  }

  const systemPrompt = fs.readFileSync(OBSERVER_PROMPT_PATH, 'utf-8');

  try {
    const result = execFileSync('claude', [
      '-p',
      '--system-prompt', systemPrompt,
      '--output-format', 'text',
    ], {
      input: conversationText,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 600_000, // 10 min
    });

    const output = result.trim();

    if (output === 'NO_OBSERVATIONS') {
      return null;
    }

    return output;
  } catch (err) {
    console.error('[Observer] claude -p failed:', err.message);
    return null;
  }
}

/**
 * Append observations to the project's observations.md.
 * Respects the Reflector lock file — retries if locked.
 */
export async function appendObservations(projectPath, observations, sessionId) {
  const obsPath = path.join(projectPath, config.OBSERVATIONS_FILE);
  const lockPath = path.join(projectPath, config.LOCK_FILE);

  // Wait for lock if Reflector is running
  let retries = 0;
  while (fs.existsSync(lockPath) && retries < config.LOCK_MAX_RETRIES) {
    console.log(`[Observer] Lock file present, waiting... (retry ${retries + 1}/${config.LOCK_MAX_RETRIES})`);
    await new Promise(r => setTimeout(r, config.LOCK_RETRY_DELAY_MS));
    retries++;
  }

  if (fs.existsSync(lockPath)) {
    console.error('[Observer] Lock file still present after max retries. Skipping append.');
    return false;
  }

  // Ensure lock directory and observations file exist
  const lockDir = path.dirname(lockPath);
  fs.mkdirSync(lockDir, { recursive: true });
  if (!fs.existsSync(obsPath)) {
    fs.writeFileSync(obsPath, '# Observations\n');
  }

  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 16);
  const header = `\n## ${dateStr} — Session ${sessionId}\n\n`;

  fs.appendFileSync(obsPath, header + observations + '\n');
  return true;
}

/**
 * Check if observations.md exceeds the token threshold.
 */
export function exceedsThreshold(projectPath, threshold) {
  const obsPath = path.join(projectPath, config.OBSERVATIONS_FILE);
  try {
    const stat = fs.statSync(obsPath);
    // Rough token estimate: chars / 4
    const estimatedTokens = stat.size / 4;
    return estimatedTokens > threshold;
  } catch {
    return false;
  }
}
