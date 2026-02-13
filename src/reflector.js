import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFLECTOR_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'reflector.md');

/**
 * Extract content between XML tags, falling back to raw text if tags are missing.
 */
function extractTagContent(text, tagName) {
  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;
  const openIdx = text.indexOf(openTag);
  const closeIdx = text.lastIndexOf(closeTag);
  if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
    return text.slice(openIdx + openTag.length, closeIdx).trim();
  }
  // Fallback: no tags found, return raw text
  return text;
}

/**
 * Run the Reflector pass to consolidate observations.md.
 * Uses file locking to prevent concurrent Observer appends.
 */
export async function runReflector(projectPath) {
  const obsPath = path.join(projectPath, config.OBSERVATIONS_FILE);
  const lockPath = path.join(projectPath, config.LOCK_FILE);
  const tmpPath = path.join(projectPath, `${config.OBSERVATIONS_FILE}.tmp`);

  // Acquire lock
  try {
    fs.writeFileSync(lockPath, String(process.pid));
  } catch (err) {
    console.error('[Reflector] Failed to acquire lock:', err.message);
    return false;
  }

  try {
    const currentContent = fs.readFileSync(obsPath, 'utf-8');

    if (!currentContent.trim()) {
      console.log('[Reflector] observations.md is empty, skipping.');
      return false;
    }

    const systemPrompt = fs.readFileSync(REFLECTOR_PROMPT_PATH, 'utf-8');

    const wrappedInput = `<observations>\n${currentContent}\n</observations>\n\nConsolidate the observations above per your instructions. Wrap your output in <observation_file_contents> tags.`;

    const result = execFileSync('claude', [
      '-p',
      '--system-prompt', systemPrompt,
      '--output-format', 'text',
    ], {
      input: wrappedInput,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 600_000, // 10 min
    });

    const consolidated = extractTagContent(result.trim(), 'observation_file_contents');

    if (!consolidated || consolidated.length < 50) {
      console.error('[Reflector] Output too short, keeping original.');
      return false;
    }

    // Write to tmp, then atomic rename
    fs.writeFileSync(tmpPath, consolidated + '\n');
    fs.renameSync(tmpPath, obsPath);

    console.log(`[Reflector] Consolidated observations.md (${currentContent.length} → ${consolidated.length} chars)`);
    return true;
  } catch (err) {
    console.error('[Reflector] Failed:', err.message);
    // Clean up tmp file if it exists
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  } finally {
    // Always release lock
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
