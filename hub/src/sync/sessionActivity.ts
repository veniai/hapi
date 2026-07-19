import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol'

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function hasHumanTextContent(content: unknown): boolean {
    if (typeof content === 'string') {
        return content.trim().length > 0
    }

    if (Array.isArray(content)) {
        return content.some((block) => {
            const record = asRecord(block)
            return record?.type === 'text'
                && typeof record.text === 'string'
                && record.text.trim().length > 0
        })
    }

    const record = asRecord(content)
    return record?.type === 'text'
        && typeof record.text === 'string'
        && record.text.trim().length > 0
}

function isReadyEventContent(content: unknown): boolean {
    const record = asRecord(content)
    if (record?.type !== 'event') {
        return false
    }

    const data = asRecord(record.data)
    return data?.type === 'ready'
}

export function shouldRecordSessionActivity(content: unknown): boolean {
    const message = unwrapRoleWrappedRecordEnvelope(content)
    if (!message) {
        return false
    }

    if (message.role === 'user') {
        return hasHumanTextContent(message.content)
    }

    if (message.role !== 'agent') {
        return false
    }

    return isReadyEventContent(message.content)
}

/** True only for agent content that completes a turn needing user handling (a
 *  `ready` event). This is the unread-attention signal (spec §4.1: "Agent 本轮
 * 完成并产生了新的用户可见结果"). Distinct from `shouldRecordSessionActivity`,
 *  which ALSO returns true for user text — user sends must NOT create attention
 *  (§4.1 / §3.1.8), so the red-dot bump uses this stricter agent-only check. */
export function isAgentResultContent(content: unknown): boolean {
    const message = unwrapRoleWrappedRecordEnvelope(content)
    if (!message || message.role !== 'agent') {
        return false
    }
    return isReadyEventContent(message.content)
}

/** Read permission/input request identities from a raw agentState blob. Used
 *  to detect additions and replacements that raise attention (§4.1). */
export function getPendingRequestIds(agentState: unknown): Set<string> {
    if (!agentState || typeof agentState !== 'object' || Array.isArray(agentState)) {
        return new Set()
    }
    const requests = (agentState as { requests?: unknown }).requests
    if (!requests || typeof requests !== 'object' || Array.isArray(requests)) {
        return new Set()
    }
    return new Set(Object.keys(requests as Record<string, unknown>))
}
