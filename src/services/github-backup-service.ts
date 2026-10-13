/**
 * GitHub backup — an export adapter, never a source of truth.
 *
 * It clones the configured repository into a temp directory, writes this user's
 * export into it, commits and pushes. Nothing reads back from GitHub: the
 * PostgreSQL database remains the only place DAMC stores memory, so losing or
 * deleting the backup repository cannot affect the hub.
 *
 * Three properties this has to get right, all of which it previously got wrong:
 *
 * USER ISOLATION. The export used to be written to the repository root, so with
 * more than one user each backup overwrote the previous user's files and pushed
 * the result — one user's memories replacing another's in a shared repository.
 * Each user now owns a path prefix (`users/<user id>/`), so two users can back up
 * to the same repository without colliding. Note that a shared repository is
 * still shared: anyone who can read it reads every user's export. That is a
 * deployment decision, and the layout at least makes it visible.
 *
 * CREDENTIALS. A non-interactive push needs the token in the remote URL
 * (`https://x-access-token:<token>@github.com/...`). That URL used to be returned
 * verbatim in the API response and reached the logs through git's own error
 * output. Every path out of this module is redacted now. DAMC never stores the
 * credential itself — it only ever reads the operator's configured value.
 *
 * FAILING USEFULLY. git is an external dependency. When it is missing, or when
 * the repository needs a credential that was not supplied, the caller gets a
 * specific error instead of a generic 500 (or, for the credential case, a request
 * that hung forever on git's terminal prompt).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { exportJson, exportObsidian } from './export-service.js';

const exec = promisify(execFile);

/**
 * Strip any `user:password@` or `token@` portion from a git URL.
 *
 * Applied to everything leaving this module — return values, thrown messages —
 * because the configured remote is the one place a credential legitimately
 * appears and it must not travel any further.
 */
export function redactRemote(value: string): string {
  return value.replace(/\/\/[^@\s/]+@/g, '//***@');
}

/**
 * git invocation shared by every step.
 *
 * - GIT_TERMINAL_PROMPT=0 turns a missing credential into an immediate failure.
 *   Without it, git blocks on a username prompt that nothing will ever answer
 *   and the HTTP request never returns.
 * - `-c credential.helper=` ignores any helper configured on the host, so the
 *   only credential used is the one in the configured remote URL.
 * - `-c user.*` supplies a commit identity inline. The runtime container has no
 *   global git config, and `git commit` without an identity fails outright.
 * - Failures are re-thrown with the credential redacted out of both the message
 *   and git's stderr.
 */
async function git(args: string[], cwd?: string): Promise<string> {
  const identity = [
    '-c', 'user.name=DAMC Backup',
    '-c', 'user.email=damc-backup@localhost',
    '-c', 'credential.helper='
  ];
  try {
    const { stdout } = await exec('git', [...identity, ...args], {
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new AppError('GIT_NOT_AVAILABLE',
        'GitHub backup needs the git command, which is not installed in this DAMC runtime. Install git in the image (the bundled Dockerfile does) or run the export to disk instead (POST /v1/export/json).',
        503);
    }
    throw new AppError('GIT_COMMAND_FAILED',
      `git ${redactRemote(args.filter(a => !a.startsWith('user.') && a !== '-c').join(' '))} failed: ${redactRemote(err.stderr?.trim() || err.message)}`,
      502);
  }
}

export async function backupToGitHub(userId: string) {
  if (!env.GITHUB_BACKUP_ENABLED || !env.GITHUB_BACKUP_REPO) {
    return { enabled: false, message: 'GitHub backup disabled or GITHUB_BACKUP_REPO not configured.' };
  }
  const repo = env.GITHUB_BACKUP_REPO;
  const safeRepo = redactRemote(repo);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-backup-'));
  const repoDir = path.join(tempRoot, 'repo');
  try {
    try {
      await git(['clone', '--depth', '1', '--branch', env.GITHUB_BACKUP_BRANCH, repo, repoDir]);
    } catch {
      // The branch may not exist yet on a fresh repository; fall back to its default.
      await git(['clone', '--depth', '1', repo, repoDir]);
    }

    // Per-user prefix: two users backing up to one repository must not overwrite
    // each other. The id is a uuid from the database, never caller-supplied text,
    // so it cannot escape the directory.
    const userDir = path.join(repoDir, 'users', userId);
    await fs.mkdir(userDir, { recursive: true });
    await exportJson(userId, userDir);
    await exportObsidian(userId, path.join(userDir, 'obsidian'));
    await fs.writeFile(path.join(userDir, '.damc-backup'), `DAMC backup marker\nUser: ${userId}\nGenerated: ${new Date().toISOString()}\n`, 'utf8');

    await git(['add', '.'], repoDir);
    // An empty commit means nothing changed since the last push — not a failure.
    const committed = await git(['commit', '-m', `DAMC backup ${new Date().toISOString()}`], repoDir).then(() => true).catch(() => false);
    if (!committed) {
      return { enabled: true, pushed: false, changed: false, repo: safeRepo, path: `users/${userId}`, message: 'No changes to commit.' };
    }
    await git(['push', env.GITHUB_BACKUP_REMOTE, `HEAD:${env.GITHUB_BACKUP_BRANCH}`], repoDir);
    return { enabled: true, pushed: true, changed: true, repo: safeRepo, branch: env.GITHUB_BACKUP_BRANCH, path: `users/${userId}` };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
