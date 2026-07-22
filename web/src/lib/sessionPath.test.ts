import { describe, expect, it } from 'vitest'
import { isSessionsIndexPath } from './sessionPath'

describe('isSessionsIndexPath', () => {
    // List routes → push entry point (system back must reach the list)
    // Everything else → replace (session switch must not stack entries)
    it.each([
        ['/sessions', true],
        ['/sessions/', true],
        ['/', false],
        ['', false],
        ['/sessions/new', false],
        ['/sessions/abc', false],
        ['/sessions/abc/', false],
        ['/sessions/abc/files', false],
        ['/sessions/abc/terminal', false],
        ['/sessions/abc/file', false],
        ['/browse', false],
        ['/settings', false],
    ])('%s → %s', (pathname, expected) => {
        expect(isSessionsIndexPath(pathname)).toBe(expected)
    })
})
