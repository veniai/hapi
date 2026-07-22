import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  WorktreeArchiveCleanup,
  WorktreeArchiveInspection,
  WorktreeArchiveRequest
} from '@hapi/protocol/apiTypes';

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  basePath: string;
  worktreePath: string;
  branch: string;
  name: string;
  createdAt: number;
  managedByHapi?: true;
  baseRef?: string;
  baseCommit?: string;
};

type WorktreeResult =
  | { ok: true; info: WorktreeInfo }
  | { ok: false; error: string };

export type RemoveWorktreeResult =
  | { ok: true }
  | { ok: false; error: string };

const MAX_ATTEMPTS = 5;

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', args, { cwd });
    return {
      stdout: result.stdout ? result.stdout.toString() : '',
      stderr: result.stderr ? result.stderr.toString() : ''
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const stderr = execError.stderr ? execError.stderr.toString() : '';
    const stdout = execError.stdout ? execError.stdout.toString() : '';
    const message = stderr.trim() || stdout.trim() || execError.message || 'Git command failed';
    throw new Error(message);
  }
}

async function resolveRepoRoot(basePath: string): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], basePath);
  const root = result.stdout.trim();
  if (!root) {
    throw new Error('Unable to resolve Git repository root.');
  }
  return root;
}

async function readCurrentBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot);
    const branch = result.stdout.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

async function readCurrentCommit(repoRoot: string): Promise<string | undefined> {
  try {
    const result = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], repoRoot);
    const commit = result.stdout.trim();
    return commit || undefined;
  } catch {
    return undefined;
  }
}

function toSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned;
}

function formatDatePrefix(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}${day}`;
}

function normalizeNameHint(nameHint?: string): string | null {
  if (!nameHint) {
    return null;
  }
  const trimmed = nameHint.trim();
  if (!trimmed) {
    return null;
  }
  const slug = toSlug(trimmed);
  return slug ? slug : null;
}

function makeDefaultBaseName(): string {
  const suffix = randomBytes(2).toString('hex');
  return `${formatDatePrefix()}-${suffix}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(options: {
  basePath: string;
  nameHint?: string;
}): Promise<WorktreeResult> {
  const { basePath, nameHint } = options;
  let repoRoot: string;
  let baseRef: string | undefined;
  let baseCommit: string | undefined;

  try {
    repoRoot = await resolveRepoRoot(basePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Path is not a Git repository: ${message}`
    };
  }

  [baseRef, baseCommit] = await Promise.all([
    readCurrentBranch(repoRoot),
    readCurrentCommit(repoRoot)
  ]);

  const repoParent = dirname(repoRoot);
  const repoName = basename(repoRoot);
  const repoWorktreesRoot = join(repoParent, `${repoName}-worktrees`);
  await mkdir(repoWorktreesRoot, { recursive: true });

  const baseName = normalizeNameHint(nameHint) ?? makeDefaultBaseName();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName}-${randomBytes(2).toString('hex')}`;
    const branch = `hapi-${name}`;
    const worktreePath = join(repoWorktreesRoot, name);

    if (await pathExists(worktreePath)) {
      continue;
    }

    if (await branchExists(repoRoot, branch)) {
      continue;
    }

    try {
      await runGit(['worktree', 'add', '-b', branch, worktreePath], repoRoot);
      return {
        ok: true,
        info: {
          basePath: repoRoot,
          worktreePath,
          branch,
          name,
          createdAt: Date.now(),
          managedByHapi: true,
          baseRef,
          baseCommit
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Failed to create worktree: ${message}`
      };
    }
  }

  return {
    ok: false,
    error: 'Failed to create worktree after multiple attempts. Try again.'
  };
}

export async function removeWorktree(options: {
  repoRoot: string;
  worktreePath: string;
}): Promise<RemoveWorktreeResult> {
  try {
    await runGit(['worktree', 'remove', options.worktreePath], options.repoRoot);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function blocker(code: Extract<WorktreeArchiveInspection, { type: 'blocker' }>['code'], message: string): WorktreeArchiveInspection {
  return { type: 'blocker', code, message };
}

type RegisteredWorktree = {
  path: string;
  branch?: string;
};

function parseRegisteredWorktrees(output: string): RegisteredWorktree[] {
  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length) };
      continue;
    }
    if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function verifyWorktreeArchiveTarget(target: WorktreeArchiveRequest): Promise<WorktreeArchiveInspection> {
  const canonicalBase = await canonicalPath(target.basePath);
  const canonicalWorktree = await canonicalPath(target.worktreePath);
  if (!canonicalBase || !canonicalWorktree || canonicalBase === canonicalWorktree) {
    return blocker('worktree_unverified', 'Worktree path cannot be safely verified.');
  }

  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot(canonicalBase);
  } catch {
    return blocker('worktree_unverified', 'Recorded base path is not a Git repository.');
  }
  const canonicalRepoRoot = await canonicalPath(repoRoot);
  if (canonicalRepoRoot !== canonicalBase) {
    return blocker('worktree_unverified', 'Recorded base path is not the repository root.');
  }

  try {
    const registered = parseRegisteredWorktrees((await runGit(['worktree', 'list', '--porcelain'], canonicalRepoRoot)).stdout);
    const canonicalRegistered = await Promise.all(registered.map(async (entry) => ({
      ...entry,
      path: await canonicalPath(entry.path)
    })));
    const match = canonicalRegistered.find((entry) => entry.path === canonicalWorktree);
    if (!match || match.branch !== target.branch) {
      return blocker('worktree_unverified', 'Worktree registration does not match the recorded branch.');
    }

    const currentBranch = (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], canonicalWorktree)).stdout.trim();
    if (currentBranch !== target.branch) {
      return blocker('worktree_unverified', 'Worktree currently has a different branch checked out.');
    }

    const baseRefExists = await runGit(
      ['rev-parse', '--verify', `${target.baseRef}^{commit}`],
      canonicalRepoRoot
    ).then(() => true).catch(() => false);
    if (!baseRefExists) {
      return blocker('worktree_unverified', 'Recorded base branch no longer exists.');
    }
    const baseDescendsFromCreation = await runGit(
      ['merge-base', '--is-ancestor', target.baseCommit, target.baseRef],
      canonicalRepoRoot
    ).then(() => true).catch(() => false);
    if (!baseDescendsFromCreation) {
      return blocker('worktree_unverified', 'The recorded base branch no longer contains the creation baseline.');
    }

    const status = (await runGit(['status', '--porcelain'], canonicalWorktree)).stdout;
    if (status.trim()) {
      return blocker('dirty_worktree', 'Worktree has uncommitted or untracked changes.');
    }

    const branchMerged = await runGit(
      ['merge-base', '--is-ancestor', target.branch, target.baseRef],
      canonicalRepoRoot
    ).then(() => true).catch(() => false);
    if (!branchMerged) {
      return blocker('unmerged_commits', 'Worktree branch still contains commits not merged into its creation base.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blocker('git_failure', `Git could not inspect this worktree: ${message}`);
  }

  return { type: 'ready' };
}

export async function inspectWorktreeArchive(target: WorktreeArchiveRequest): Promise<WorktreeArchiveInspection> {
  return await verifyWorktreeArchiveTarget(target);
}

export async function cleanupWorktreeArchive(target: WorktreeArchiveRequest): Promise<WorktreeArchiveCleanup> {
  const inspection = await verifyWorktreeArchiveTarget(target);
  if (inspection.type === 'blocker') {
    return inspection;
  }

  const [canonicalBase, canonicalWorktree] = await Promise.all([
    canonicalPath(target.basePath),
    canonicalPath(target.worktreePath)
  ]);
  if (!canonicalBase || !canonicalWorktree) {
    return blocker('worktree_unverified', 'Worktree path changed before cleanup could run.');
  }

  try {
    await runGit(['worktree', 'remove', canonicalWorktree], canonicalBase);
    await runGit(['branch', '-d', '--', target.branch], canonicalBase);
    return { type: 'success' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blocker('git_failure', `Git could not clean this worktree: ${message}`);
  }
}
