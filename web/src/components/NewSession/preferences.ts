import { CREATABLE_AGENT_FLAVORS, GROK_PERMISSION_MODES, type GrokPermissionMode } from '@hapi/protocol'
import type { AgentType, CodexReasoningEffort, LaunchEffort } from './types'

const AGENT_STORAGE_KEY = 'hapi:newSession:agent'
const YOLO_STORAGE_KEY = 'hapi:newSession:yolo'
const AGENT_PREFERENCES_STORAGE_KEY = 'hapi:newSession:agentPreferences'

// Only launchable flavors are valid defaults; a stale 'gemini' preference
// (no longer creatable) falls back to 'claude'.
const VALID_AGENTS = CREATABLE_AGENT_FLAVORS

export type PreferredAgentSettings = {
    model: string
    cursorSelectedBase: string
    effortByModel: Record<string, LaunchEffort>
    modelReasoningEffortByModel: Record<string, CodexReasoningEffort>
    grokPermissionMode: GrokPermissionMode
}

type StoredAgentSettings = Partial<PreferredAgentSettings>

const DEFAULT_AGENT_SETTINGS: PreferredAgentSettings = {
    model: 'auto',
    cursorSelectedBase: 'auto',
    effortByModel: {},
    modelReasoningEffortByModel: {},
    grokPermissionMode: 'default'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAgentPreferences(): Record<string, StoredAgentSettings> {
    try {
        const raw = localStorage.getItem(AGENT_PREFERENCES_STORAGE_KEY)
        if (!raw) {
            return {}
        }
        const parsed: unknown = JSON.parse(raw)
        if (!isRecord(parsed)) {
            return {}
        }

        const result: Record<string, StoredAgentSettings> = {}
        for (const [agent, settings] of Object.entries(parsed)) {
            if (isRecord(settings)) {
                result[agent] = settings as StoredAgentSettings
            }
        }
        return result
    } catch {
        return {}
    }
}

function normalizeStringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) {
        return {}
    }
    const result: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string') {
            result[key] = entry
        }
    }
    return result
}

function normalizeModelKey(model: string): string {
    const trimmed = model.trim()
    return trimmed || 'auto'
}

function getAgentSettings(agent: AgentType): PreferredAgentSettings {
    const stored = readAgentPreferences()[agent]
    const grokPermissionMode = stored?.grokPermissionMode

    return {
        model: typeof stored?.model === 'string' && stored.model.trim()
            ? normalizeModelKey(stored.model)
            : DEFAULT_AGENT_SETTINGS.model,
        cursorSelectedBase: typeof stored?.cursorSelectedBase === 'string' && stored.cursorSelectedBase.trim()
            ? normalizeModelKey(stored.cursorSelectedBase)
            : DEFAULT_AGENT_SETTINGS.cursorSelectedBase,
        effortByModel: normalizeStringMap(stored?.effortByModel),
        modelReasoningEffortByModel: normalizeStringMap(stored?.modelReasoningEffortByModel),
        grokPermissionMode: GROK_PERMISSION_MODES.includes(grokPermissionMode as GrokPermissionMode)
            ? grokPermissionMode as GrokPermissionMode
            : DEFAULT_AGENT_SETTINGS.grokPermissionMode
    }
}

function writeAgentPreferences(preferences: Record<string, StoredAgentSettings>): void {
    try {
        localStorage.setItem(AGENT_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
    } catch {
        // Ignore storage errors
    }
}

export function loadPreferredAgent(): AgentType {
    try {
        const stored = localStorage.getItem(AGENT_STORAGE_KEY)
        if (stored && VALID_AGENTS.includes(stored as AgentType)) {
            return stored as AgentType
        }
    } catch {
        // Ignore storage errors
    }
    return 'claude'
}

export function savePreferredAgent(agent: AgentType): void {
    try {
        localStorage.setItem(AGENT_STORAGE_KEY, agent)
    } catch {
        // Ignore storage errors
    }
}

export function loadPreferredYoloMode(): boolean {
    try {
        return localStorage.getItem(YOLO_STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

export function savePreferredYoloMode(enabled: boolean): void {
    try {
        localStorage.setItem(YOLO_STORAGE_KEY, enabled ? 'true' : 'false')
    } catch {
        // Ignore storage errors
    }
}

export function loadPreferredAgentSettings(agent: AgentType): PreferredAgentSettings {
    return getAgentSettings(agent)
}

export function savePreferredAgentSettings(agent: AgentType, settings: PreferredAgentSettings): void {
    const preferences = readAgentPreferences()
    preferences[agent] = {
        model: normalizeModelKey(settings.model),
        cursorSelectedBase: normalizeModelKey(settings.cursorSelectedBase),
        effortByModel: normalizeStringMap(settings.effortByModel),
        modelReasoningEffortByModel: normalizeStringMap(settings.modelReasoningEffortByModel),
        grokPermissionMode: GROK_PERMISSION_MODES.includes(settings.grokPermissionMode)
            ? settings.grokPermissionMode
            : DEFAULT_AGENT_SETTINGS.grokPermissionMode
    }
    writeAgentPreferences(preferences)
}

export function loadPreferredEffort(agent: AgentType, model: string): LaunchEffort {
    return loadPreferredAgentSettings(agent).effortByModel[normalizeModelKey(model)] ?? 'auto'
}

export function savePreferredEffort(agent: AgentType, model: string, effort: LaunchEffort): void {
    const settings = loadPreferredAgentSettings(agent)
    settings.effortByModel[normalizeModelKey(model)] = effort
    savePreferredAgentSettings(agent, settings)
}

export function loadPreferredModelReasoningEffort(
    agent: AgentType,
    model: string
): CodexReasoningEffort {
    return loadPreferredAgentSettings(agent).modelReasoningEffortByModel[normalizeModelKey(model)] ?? 'default'
}

export function savePreferredModelReasoningEffort(
    agent: AgentType,
    model: string,
    effort: CodexReasoningEffort
): void {
    const settings = loadPreferredAgentSettings(agent)
    settings.modelReasoningEffortByModel[normalizeModelKey(model)] = effort
    savePreferredAgentSettings(agent, settings)
}

export function savePreferredModel(
    agent: AgentType,
    model: string,
    cursorSelectedBase?: string
): void {
    const settings = loadPreferredAgentSettings(agent)
    settings.model = normalizeModelKey(model)
    if (cursorSelectedBase !== undefined) {
        settings.cursorSelectedBase = normalizeModelKey(cursorSelectedBase)
    }
    savePreferredAgentSettings(agent, settings)
}

export function savePreferredGrokPermissionMode(
    agent: AgentType,
    permissionMode: GrokPermissionMode
): void {
    const settings = loadPreferredAgentSettings(agent)
    settings.grokPermissionMode = permissionMode
    savePreferredAgentSettings(agent, settings)
}
