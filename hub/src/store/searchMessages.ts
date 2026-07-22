import type { Database } from 'bun:sqlite'

export type SearchHit = {
    messageId: string
    sessionId: string
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
    seq: number
    created_at: number
    path: string
    rank: number
    snippet: string
}

/**
 * Full-text search over message content, scoped to one namespace + project path
 * (multi-agent-blackboard #3). Backed by the messages_fts external-content index
 * (V14). `namespace` MUST come from the authenticated caller at the route layer —
 * never from client input — so a caller in namespace A cannot read B's messages
 * (the JOIN on s.namespace enforces it regardless). Results ranked by bm25 and
 * include an FTS5 snippet of the matching text.
 */
export function searchMessages(
    db: Database,
    namespace: string,
    path: string,
    query: string,
    limit: number = 20
): SearchHit[] {
    const rows = db.prepare(`
        SELECT m.id           AS message_id,
               m.session_id   AS session_id,
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
          AND json_extract(s.metadata, '$.path') = $path
        ORDER BY rank
        LIMIT $limit
    `).all({ query, namespace, path, limit }) as SearchRow[]
    return rows.map((r) => ({
        messageId: r.message_id,
        sessionId: r.session_id,
        seq: r.seq,
        createdAt: r.created_at,
        path: r.path,
        rank: r.rank,
        contentSnippet: r.snippet,
    }))
}
