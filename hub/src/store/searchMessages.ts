import type { Database } from 'bun:sqlite'

export type SearchHit = {
    messageId: string
    sessionId: string
    /** Human-readable session title; falls back to summary, worktree name, then path. */
    sessionName: string
    seq: number
    createdAt: number
    path: string
    /** bm25 rank — more negative = more relevant. */
    rank: number
    /** Matching text fragment (FTS5 snippet) so the caller can judge relevance without a second round-trip. */
    contentSnippet: string
}

type SearchRow = {
    message_id: string
    session_id: string
    session_name: string
    seq: number
    created_at: number
    path: string
    rank: number
    snippet: string
}

/**
 * Full-text search over message content, scoped to one namespace + workspace path
 * (multi-agent-blackboard #3). Backed by the messages_fts external-content index
 * (V14). `namespace` MUST come from the authenticated caller at the route layer —
 * never from client input — so a caller in namespace A cannot read B's messages
 * (the JOIN on s.namespace enforces it regardless). Results ranked by bm25 and
 * include an FTS5 snippet of the matching text. Legacy sessions fall back from
 * workspacePath to worktree.basePath to path; callers may exclude the active
 * session so a search cannot return the conversation that issued it.
 */
export function searchMessages(
    db: Database,
    namespace: string,
    workspacePath: string,
    query: string,
    limit: number = 20,
    excludeSessionId?: string
): SearchHit[] {
    const excludeClause = excludeSessionId ? 'AND s.id != $excludeSessionId' : ''
    const rows = db.prepare(`
        SELECT m.id           AS message_id,
               m.session_id   AS session_id,
               COALESCE(
                   NULLIF(json_extract(s.metadata, '$.name'), ''),
                   NULLIF(json_extract(s.metadata, '$.summary.text'), ''),
                   NULLIF(json_extract(s.metadata, '$.worktree.name'), ''),
                   json_extract(s.metadata, '$.path')
               )                AS session_name,
               m.seq          AS seq,
               m.created_at   AS created_at,
               json_extract(s.metadata, '$.path') AS path,
               bm25(messages_fts)                  AS rank,
               snippet(messages_fts, 0, '>>>', '<<<', '…', 12) AS snippet
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH $query
          AND s.namespace = $namespace
          AND (
                COALESCE(
                    json_extract(s.metadata, '$.workspacePath'),
                    json_extract(s.metadata, '$.worktree.basePath'),
                    json_extract(s.metadata, '$.path')
                ) = $workspacePath
                OR json_extract(s.metadata, '$.path') = $workspacePath
              )
          ${excludeClause}
        ORDER BY rank
        LIMIT $limit
    `).all({
        query,
        namespace,
        workspacePath,
        limit,
        ...(excludeSessionId ? { excludeSessionId } : {})
    }) as SearchRow[]
    return rows.map((r) => ({
        messageId: r.message_id,
        sessionId: r.session_id,
        sessionName: r.session_name,
        seq: r.seq,
        createdAt: r.created_at,
        path: r.path,
        rank: r.rank,
        contentSnippet: r.snippet,
    }))
}
