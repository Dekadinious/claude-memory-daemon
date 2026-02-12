import { execSync } from 'child_process';
import config from './config.js';

/**
 * Auto-commit OBSERVATIONS.md if the project is a git repo and the file is tracked.
 * Silently skips if not a git repo or if the file is gitignored.
 */
export function autoCommitObservations(projectPath) {
  try {
    // Check if it's a git repo
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: projectPath,
      stdio: 'pipe',
    });
  } catch {
    // Not a git repo, skip silently
    return false;
  }

  try {
    // Check if the file is gitignored
    execSync(`git check-ignore -q "${config.OBSERVATIONS_FILE}"`, {
      cwd: projectPath,
      stdio: 'pipe',
    });
    // Exit code 0 = file IS ignored, skip
    return false;
  } catch {
    // Exit code 1 = file is NOT ignored, proceed with commit
  }

  try {
    execSync(`git add "${config.OBSERVATIONS_FILE}" && git commit -m "chore: update observational memory" --no-verify`, {
      cwd: projectPath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    // Nothing to commit (no changes) or other git error
    return false;
  }
}
