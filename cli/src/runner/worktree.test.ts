import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorktreeArchiveRequest } from '@hapi/protocol/apiTypes'
import { cleanupWorktreeArchive, createWorktree, inspectWorktreeArchive } from './worktree'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function git(cwd: string, args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd })
}

async function createRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'hapi-worktree-archive-'))
    tempDirs.push(root)
    tempDirs.push(`${root}-worktrees`)
    await git(root, ['init', '--initial-branch=main'])
    await git(root, ['config', 'user.name', 'HAPI test'])
    await git(root, ['config', 'user.email', 'hapi-test@example.invalid'])
    await writeFile(join(root, 'README.md'), 'initial\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'initial'])
    return root
}

async function createArchiveRequest(repo: string, name: string): Promise<WorktreeArchiveRequest> {
    const created = await createWorktree({ basePath: repo, nameHint: name })
    if (!created.ok) throw new Error(created.error)
    if (!created.info.baseRef || !created.info.baseCommit) {
        throw new Error('test repository did not record a base ref and commit')
    }
    return {
        ...created.info,
        managedByHapi: true,
        baseRef: created.info.baseRef,
        baseCommit: created.info.baseCommit,
        hostPid: process.pid
    }
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('worktree archive inspection', () => {
    it('blocks a clean worktree with unmerged commits', async () => {
        const repo = await createRepository()
        const request = await createArchiveRequest(repo, 'unmerged')
        await writeFile(join(request.worktreePath, 'feature.txt'), 'feature\n')
        await git(request.worktreePath, ['add', 'feature.txt'])
        await git(request.worktreePath, ['commit', '-m', 'feature'])

        await expect(inspectWorktreeArchive(request)).resolves.toEqual({
            type: 'blocker',
            code: 'unmerged_commits',
            message: expect.any(String)
        })
    })

    it.each([
        ['staged', async (path: string) => {
            await writeFile(join(path, 'staged.txt'), 'staged\n')
            await git(path, ['add', 'staged.txt'])
        }],
        ['unstaged', async (path: string) => {
            await writeFile(join(path, 'README.md'), 'changed\n')
        }],
        ['untracked', async (path: string) => {
            await writeFile(join(path, 'untracked.txt'), 'untracked\n')
        }]
    ])('blocks %s changes', async (_kind, makeDirty) => {
        const repo = await createRepository()
        const request = await createArchiveRequest(repo, `dirty-${_kind}`)
        await makeDirty(request.worktreePath)

        await expect(inspectWorktreeArchive(request)).resolves.toEqual({
            type: 'blocker',
            code: 'dirty_worktree',
            message: expect.any(String)
        })
    })

    it('removes only a clean, merged worktree and branch', async () => {
        const repo = await createRepository()
        const request = await createArchiveRequest(repo, 'merged')
        await writeFile(join(request.worktreePath, 'feature.txt'), 'feature\n')
        await git(request.worktreePath, ['add', 'feature.txt'])
        await git(request.worktreePath, ['commit', '-m', 'feature'])
        await git(repo, ['merge', '--ff-only', request.branch])

        await expect(inspectWorktreeArchive(request)).resolves.toEqual({ type: 'ready' })
        await expect(cleanupWorktreeArchive(request)).resolves.toEqual({ type: 'success' })

        const worktrees = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repo })
        expect(String(worktrees.stdout)).not.toContain(request.worktreePath)
        await expect(execFileAsync('git', ['show-ref', '--verify', `refs/heads/${request.branch}`], { cwd: repo }))
            .rejects.toThrow()
    })

    it('force-removes a dirty, unmerged worktree only when explicitly requested', async () => {
        const repo = await createRepository()
        const request = await createArchiveRequest(repo, 'force-cleanup')
        await writeFile(join(request.worktreePath, 'discarded.txt'), 'discarded\n')
        await git(request.worktreePath, ['add', 'discarded.txt'])
        await git(request.worktreePath, ['commit', '-m', 'unmerged'])
        await writeFile(join(request.worktreePath, 'dirty.txt'), 'dirty\n')

        await expect(cleanupWorktreeArchive({ ...request, force: true })).resolves.toEqual({ type: 'success' })
        const worktrees = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repo })
        expect(String(worktrees.stdout)).not.toContain(request.worktreePath)
        await expect(execFileAsync('git', ['show-ref', '--verify', `refs/heads/${request.branch}`], { cwd: repo }))
            .rejects.toThrow()
    })

    it('blocks a request whose recorded branch is not the registered worktree branch', async () => {
        const repo = await createRepository()
        const request = await createArchiveRequest(repo, 'mismatch')

        await expect(inspectWorktreeArchive({ ...request, branch: 'main' })).resolves.toEqual({
            type: 'blocker',
            code: 'worktree_unverified',
            message: expect.any(String)
        })
    })

    it('blocks a request whose creation baseline no longer exists', async () => {
        const repo = await createRepository()
        const request = await createArchiveRequest(repo, 'missing-base')

        await expect(inspectWorktreeArchive({ ...request, baseRef: 'missing-base' })).resolves.toEqual({
            type: 'blocker',
            code: 'worktree_unverified',
            message: expect.any(String)
        })
    })
})
