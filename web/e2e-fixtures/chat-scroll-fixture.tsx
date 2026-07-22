import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
    scrollViewportToBottom,
    scrollViewportToStart,
} from '../src/components/AssistantChat/HappyThread'

type ChatScrollMetrics = {
    windowScrollY: number
    bodyScrollTop: number
    htmlScrollTop: number
    appTop: number
    appBottom: number
    viewportScrollTop: number
    viewportScrollHeight: number
    viewportClientHeight: number
}

declare global {
    interface Window {
        __chatScrollE2E?: {
            send(): void
            alignTarget(): void
            reset(): void
            read(): ChatScrollMetrics
        }
    }
}

function readMetrics(viewport: HTMLElement): ChatScrollMetrics {
    const app = document.querySelector<HTMLElement>('.chat-app')
    return {
        windowScrollY: window.scrollY,
        bodyScrollTop: document.body.scrollTop,
        htmlScrollTop: document.documentElement.scrollTop,
        appTop: app?.getBoundingClientRect().top ?? 0,
        appBottom: app?.getBoundingClientRect().bottom ?? 0,
        viewportScrollTop: viewport.scrollTop,
        viewportScrollHeight: viewport.scrollHeight,
        viewportClientHeight: viewport.clientHeight,
    }
}

function App() {
    const viewportRef = useRef<HTMLDivElement>(null)
    const [targetMounted, setTargetMounted] = useState(false)
    const [sendVersion, setSendVersion] = useState(0)

    useEffect(() => {
        window.__chatScrollE2E = {
            send() {
                setTargetMounted(true)
                setSendVersion((version) => version + 1)
            },
            alignTarget() {
                const viewport = viewportRef.current
                const target = document.querySelector<HTMLElement>('.chat-target')
                if (viewport && target) {
                    scrollViewportToStart(viewport, target, 'instant')
                }
            },
            reset() {
                document.body.scrollTop = 0
                document.documentElement.scrollTop = 0
                viewportRef.current?.scrollTo({ top: 0, behavior: 'instant' })
                setTargetMounted(false)
                setSendVersion(0)
            },
            read() {
                const viewport = viewportRef.current
                if (!viewport) {
                    throw new Error('chat viewport is not mounted')
                }
                return readMetrics(viewport)
            },
        }
        return () => {
            delete window.__chatScrollE2E
        }
    }, [])

    useEffect(() => {
        if (sendVersion === 0) return
        const viewport = viewportRef.current
        if (!viewport) return

        scrollViewportToBottom(viewport, 'instant')
        const timers = [50, 200, 500].map((delay) => window.setTimeout(() => {
            scrollViewportToBottom(viewport, 'instant')
        }, delay))
        return () => timers.forEach((timer) => window.clearTimeout(timer))
    }, [sendVersion])

    return (
        <div className="chat-app">
            <div className="chat-header">header</div>
            <div className="chat-drag-zone">
                <div className="chat-thread">
                    <div ref={viewportRef} className="chat-viewport">
                        <div className="chat-content">
                            {targetMounted ? (
                                <div className="chat-target">new user message</div>
                            ) : null}
                        </div>
                    </div>
                    <div className="chat-composer">composer</div>
                </div>
            </div>
        </div>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
