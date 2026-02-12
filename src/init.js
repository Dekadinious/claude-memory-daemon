import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { loadState, saveState, updateFileOffset } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Initialize a project for observational memory.
 * @param {string} projectPath
 * @param {object} opts
 * @param {boolean} opts.noCatchup - Skip initial catchup of existing conversations
 */
export function initProject(projectPath, opts = {}) {
  projectPath = path.resolve(projectPath);

  console.log(`Initializing observational memory for: ${projectPath}`);

  // 1. Register with daemon
  registerProject(projectPath, opts);

  // 2. Create .claude directory structure
  const claudeDir = path.join(projectPath, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // 3. Copy session-start hook
  const hookSrc = path.join(__dirname, '..', 'hooks', 'session-start.sh');
  const hookDst = path.join(hooksDir, 'session-start.sh');
  fs.copyFileSync(hookSrc, hookDst);
  fs.chmodSync(hookDst, 0o755);
  console.log('  ✓ Created .claude/hooks/session-start.sh');

  // 4. Merge hook config into settings.json
  mergeSettings(claudeDir);
  console.log('  ✓ Updated .claude/settings.json');

  // 5. Create empty OBSERVATIONS.md in project root
  const obsPath = path.join(projectPath, config.OBSERVATIONS_FILE);
  if (!fs.existsSync(obsPath)) {
    fs.writeFileSync(obsPath, '# Observations\n');
    console.log('  ✓ Created OBSERVATIONS.md');
  } else {
    console.log('  ✓ OBSERVATIONS.md already exists');
  }

  // 6. Add CLAUDE.md section
  addClaudeMdSection(projectPath);

  // 7. Seed state with existing conversations so daemon only watches for NEW content
  const claudeProjectDir = projectPath.replace(/\//g, '-').replace(/^-/, '-');
  seedExistingState(projectPath, claudeProjectDir, opts.noCatchup);

  console.log('\nDone! Start the daemon with: claude-memory start');
}

function registerProject(projectPath, opts = {}) {
  fs.mkdirSync(config.DAEMON_DIR, { recursive: true });

  let data = { projects: [] };
  try {
    data = JSON.parse(fs.readFileSync(config.PROJECTS_FILE, 'utf-8'));
  } catch {}

  // Check if already registered
  if (data.projects.some(p => p.path === projectPath)) {
    console.log('  ✓ Project already registered');
    return;
  }

  // Derive Claude project dir name (path with slashes replaced by dashes)
  const claudeProjectDir = projectPath.replace(/\//g, '-').replace(/^-/, '-');

  data.projects.push({
    path: projectPath,
    claudeProjectDir,
    reflectorThreshold: config.DEFAULT_REFLECTOR_THRESHOLD,
    skipCatchup: opts.noCatchup || false,
    registeredAt: new Date().toISOString(),
  });

  fs.writeFileSync(config.PROJECTS_FILE, JSON.stringify(data, null, 2));
  console.log('  ✓ Registered project with daemon');
}

function mergeSettings(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.json');

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {}

  if (!settings.hooks) {
    settings.hooks = {};
  }

  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }

  // Check if our hook is already configured
  const existing = settings.hooks.SessionStart.find(
    h => h.command && h.command.includes('session-start.sh')
  );

  if (!existing) {
    settings.hooks.SessionStart.push({
      matcher: 'startup|resume|clear|compact',
      command: '.claude/hooks/session-start.sh',
    });
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Seed state with existing JSONL files at their current size.
 *
 * Normal init (noCatchup=false): seeds all EXCEPT the 10 newest by mtime,
 *   so catchup processes the 10 most recent conversations on first start.
 * Skip-history init (noCatchup=true): seeds ALL files, so nothing gets
 *   caught up — daemon only watches for brand new content.
 */
function seedExistingState(projectPath, claudeProjectDir, noCatchup = false) {
  const claudeDir = path.join(config.CLAUDE_PROJECTS_DIR, claudeProjectDir);

  if (!fs.existsSync(claudeDir)) {
    console.log('  ✓ No existing conversations to seed (Claude project dir not found yet)');
    return;
  }

  const state = loadState(projectPath);

  // If state already has files tracked, don't re-seed (project was already initialized)
  if (Object.keys(state.files).length > 0) {
    console.log('  ✓ State already has tracked files, skipping seed');
    return;
  }

  let files;
  try {
    files = fs.readdirSync(claudeDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        stat: fs.statSync(path.join(claudeDir, f)),
      }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  } catch (err) {
    console.warn(`  ⚠ Could not seed state: ${err.message}`);
    return;
  }

  // For normal init, leave the 10 newest unseeded so catchup processes them
  const toSeed = noCatchup ? files : files.slice(config.MAX_CATCHUP_FILES);

  for (const file of toSeed) {
    updateFileOffset(state, file.name, file.stat.size, 0);
  }

  if (toSeed.length > 0) {
    saveState(projectPath, state);
    const kept = files.length - toSeed.length;
    if (noCatchup) {
      console.log(`  ✓ Seeded state for ${toSeed.length} conversations (skip-history: no catchup)`);
    } else {
      console.log(`  ✓ Seeded state for ${toSeed.length} conversations (${kept} newest left for catchup)`);
    }
  } else {
    console.log(`  ✓ ${files.length} conversations found, all left for catchup`);
  }
}

function addClaudeMdSection(projectPath) {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  const section = `
## Observational Memory

This project uses observational memory. At the start of each session, you
receive an OBSERVATIONS.md file containing compressed knowledge from previous
sessions. These observations include:

- Architectural decisions and their reasoning
- File locations (especially non-obvious ones)
- Dead ends that were explored and didn't work
- Configuration facts and environment details
- Bug root causes and fixes
- Code conventions and patterns

**How to use observations**: Treat these as reliable institutional knowledge. If
observations say a file is at a specific path, go there directly — don't search.
If observations say an approach was tried and failed, don't retry it unless
explicitly asked. If observations mention a convention, follow it.

**If observations seem wrong or outdated**: Trust what you see in the actual code
over observations. The code is the source of truth. But mention the discrepancy
so the observation can be corrected in a future pass.
`;

  let content = '';
  try {
    content = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {}

  if (content.includes('Observational Memory')) {
    console.log('  ✓ CLAUDE.md already has Observational Memory section');
    return;
  }

  fs.appendFileSync(claudeMdPath, section);
  console.log('  ✓ Added Observational Memory section to CLAUDE.md');
}

