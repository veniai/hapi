import { beforeEach, describe, expect, it } from 'vitest'
import {
    loadPreferredAgentSettings,
    loadPreferredAgent,
    loadPreferredEffort,
    loadPreferredModelReasoningEffort,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredGrokPermissionMode,
    savePreferredModel,
    savePreferredEffort,
    savePreferredModelReasoningEffort,
    savePreferredYoloMode,
} from './preferences'

describe('NewSession preferences', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('loads defaults when storage is empty', () => {
        expect(loadPreferredAgent()).toBe('claude')
        expect(loadPreferredYoloMode()).toBe(false)
        expect(loadPreferredAgentSettings('codex')).toEqual({
            model: 'auto',
            cursorSelectedBase: 'auto',
            effortByModel: {},
            modelReasoningEffortByModel: {},
            grokPermissionMode: 'default'
        })
    })

    it('loads saved values from storage', () => {
        localStorage.setItem('hapi:newSession:agent', 'codex')
        localStorage.setItem('hapi:newSession:yolo', 'true')

        expect(loadPreferredAgent()).toBe('codex')
        expect(loadPreferredYoloMode()).toBe(true)
    })

    it('falls back to default agent on invalid stored value', () => {
        localStorage.setItem('hapi:newSession:agent', 'unknown-agent')

        expect(loadPreferredAgent()).toBe('claude')
    })

    it('persists new values to storage', () => {
        savePreferredAgent('gemini')
        savePreferredYoloMode(true)

        expect(localStorage.getItem('hapi:newSession:agent')).toBe('gemini')
        expect(localStorage.getItem('hapi:newSession:yolo')).toBe('true')
    })

    it('keeps model and effort preferences separate for each model', () => {
        savePreferredModel('claude', 'sonnet')
        savePreferredEffort('claude', 'sonnet', 'high')
        savePreferredEffort('claude', 'opus', 'max')
        savePreferredModelReasoningEffort('codex', 'gpt-5', 'xhigh')

        expect(loadPreferredAgentSettings('claude').model).toBe('sonnet')
        expect(loadPreferredEffort('claude', 'sonnet')).toBe('high')
        expect(loadPreferredEffort('claude', 'opus')).toBe('max')
        expect(loadPreferredEffort('claude', 'auto')).toBe('auto')
        expect(loadPreferredModelReasoningEffort('codex', 'gpt-5')).toBe('xhigh')
        expect(loadPreferredModelReasoningEffort('codex', 'o3')).toBe('default')
    })

    it('validates stored permission modes and ignores malformed maps', () => {
        localStorage.setItem('hapi:newSession:agentPreferences', JSON.stringify({
            grok: {
                model: 'grok-4.5',
                effortByModel: { 'grok-4.5': 'high', invalid: 123 },
                modelReasoningEffortByModel: 'invalid',
                grokPermissionMode: 'unknown'
            }
        }))

        expect(loadPreferredAgentSettings('grok')).toEqual({
            model: 'grok-4.5',
            cursorSelectedBase: 'auto',
            effortByModel: { 'grok-4.5': 'high' },
            modelReasoningEffortByModel: {},
            grokPermissionMode: 'default'
        })

        savePreferredGrokPermissionMode('grok', 'auto')
        expect(loadPreferredAgentSettings('grok').grokPermissionMode).toBe('auto')
    })
})
