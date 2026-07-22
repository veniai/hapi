/**
 * Is pathname the sessions index (list) route?
 *
 * Single source of truth for "are we on the list?", shared by:
 *  - router.tsx `isSessionsIndex` (list/detail container toggle)
 *  - useOpenSession + inline nav (push-vs-replace decision;
 *    see doc/spec/web-session-back-stack.md §5.1)
 *
 * Both `/sessions` and `/sessions/` count: TanStack Router's default
 * `trailingSlash: 'never'` only normalizes *generated* URLs; an inbound
 * `/sessions/` (bookmark/external link) reaches `location.pathname` unstripped
 * (decodePath fast-path returns it as-is), so missing the trailing-slash form
 * would make the first session open `replace` the list entry.
 */
export function isSessionsIndexPath(pathname: string): boolean {
    return pathname === '/sessions' || pathname === '/sessions/'
}
