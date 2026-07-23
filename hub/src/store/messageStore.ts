import type { Database } from 'bun:sqlite'

import type { StoredMessage } from './types'
import {
    addMessage,
    cancelQueuedMessage,
    deleteQueuedMessageById,
    lookupQueuedMessage,
    getMessages,
    getFirstMessages,
    getLatestUserMessage,
    getDeliverableMessagesAfter,
    getMessagesByPosition,
    getMessagesByPositionAfter,
    getLocalMessageStates,
    getUninvokedLocalMessages,
    getMatureScheduledMessages,
    getImmediateQueuedLocalMessages,
    countFutureScheduledBySessionIds,
    countFutureScheduledLocalMessages,
    minFutureScheduledAtBySessionIds,
    countMessages,
    markMessagesInvoked,
    mergeSessionMessages,
    copyMessageToSession as copyStoredMessageToSession,
    getAllMessages,
    type CancelQueuedMessageResult,
    type LookupQueuedMessageResult,
    type LocalMessageState,
} from './messages'
import { searchMessages as searchMessagesFn, type SearchHit } from './searchMessages'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string, scheduledAt?: number | null): StoredMessage {
        return addMessage(this.db, sessionId, content, localId, scheduledAt)
    }

    /** Full-text search over message content (multi-agent-blackboard #3). */
    searchMessages(namespace: string, workspacePath: string, query: string, limit: number = 20, excludeSessionId?: string): SearchHit[] {
        return searchMessagesFn(this.db, namespace, workspacePath, query, limit, excludeSessionId)
    }

    copyMessageToSession(
        sessionId: string,
        message: Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt'>
    ): StoredMessage {
        // 中文注释：重复会话合并时需要保留源消息的时间戳和排队信息，因此走专门的复制入口而不是普通 addMessage。
        return copyStoredMessageToSession(this.db, sessionId, message)
    }

    getAllMessages(sessionId: string): StoredMessage[] {
        return getAllMessages(this.db, sessionId)
    }

    getMessages(sessionId: string, limit: number = 200): StoredMessage[] {
        return getMessages(this.db, sessionId, limit)
    }

    getFirstMessages(sessionId: string, limit: number = 50): StoredMessage[] {
        return getFirstMessages(this.db, sessionId, limit)
    }

    getLatestUserMessage(sessionId: string): StoredMessage | null {
        return getLatestUserMessage(this.db, sessionId)
    }

    getDeliverableMessagesAfter(sessionId: string, afterSeq: number, now: number, limit: number = 200): StoredMessage[] {
        return getDeliverableMessagesAfter(this.db, sessionId, afterSeq, now, limit)
    }

    getMessagesByPosition(sessionId: string, limit: number, before?: { at: number; seq: number }): StoredMessage[] {
        return getMessagesByPosition(this.db, sessionId, limit, before)
    }

    getMessagesByPositionAfter(sessionId: string, limit: number, after?: { at: number; seq: number }): StoredMessage[] {
        return getMessagesByPositionAfter(this.db, sessionId, limit, after)
    }

    getLocalMessageStates(sessionId: string, localIds: string[]): LocalMessageState[] {
        return getLocalMessageStates(this.db, sessionId, localIds)
    }

    getUninvokedLocalMessages(sessionId: string): StoredMessage[] {
        return getUninvokedLocalMessages(this.db, sessionId)
    }

    getMatureScheduledMessages(beforeTime: number): StoredMessage[] {
        return getMatureScheduledMessages(this.db, beforeTime)
    }

    getImmediateQueuedLocalMessages(sessionId: string): StoredMessage[] {
        return getImmediateQueuedLocalMessages(this.db, sessionId)
    }

    countFutureScheduledLocalMessages(sessionId: string, now: number = Date.now()): number {
        return countFutureScheduledLocalMessages(this.db, sessionId, now)
    }

    countFutureScheduledBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return countFutureScheduledBySessionIds(this.db, sessionIds, now)
    }

    minFutureScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return minFutureScheduledAtBySessionIds(this.db, sessionIds, now)
    }

    countMessages(sessionId: string): number {
        return countMessages(this.db, sessionId)
    }

    /** Count messages in a session whose local_id starts with `prefix` and were
     *  created at/after `sinceMs`. Used by [1302] rate backoff tier (spec §6.5). */
    countRecentByLocalIdPrefix(sessionId: string, prefix: string, sinceMs: number): number {
        const row = this.db.prepare(
            'SELECT COUNT(*) as n FROM messages WHERE session_id = ? AND local_id LIKE ? AND created_at >= ?'
        ).get(sessionId, prefix + '%', sinceMs) as { n: number }
        return row.n
    }

    cancelQueuedMessage(sessionId: string, messageId: string): CancelQueuedMessageResult {
        return cancelQueuedMessage(this.db, sessionId, messageId)
    }

    lookupQueuedMessage(sessionId: string, messageId: string): LookupQueuedMessageResult {
        return lookupQueuedMessage(this.db, sessionId, messageId)
    }

    deleteQueuedMessageById(sessionId: string, messageId: string): void {
        deleteQueuedMessageById(this.db, sessionId, messageId)
    }

    markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number): void {
        markMessagesInvoked(this.db, sessionId, localIds, invokedAt)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }
}
