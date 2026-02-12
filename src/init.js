import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';

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

