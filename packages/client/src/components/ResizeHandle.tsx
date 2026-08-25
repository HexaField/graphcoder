/**
 * Reusable drag-to-resize handle — a thin strip that sits at a panel edge.
 *
 * Renders as a 4px transparent strip that highlights on hover.  Dragging
 * calls `onResize` with the new panel size on every mousemove frame.
 */
import type { Component } from 'solid-js'

// ── localStorage helpers ────────────────────────────────────────────────────

export function readLayoutSize(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(`graphcoder-layout:${key}`)
    if (v !== null) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch {
    /* localStorage unavailable */
  }
  return fallback
}

export function saveLayoutSize(key: string, value: number): void {
  try {
    localStorage.setItem(`graphcoder-layout:${key}`, String(Math.round(value)))
  } catch {
    /* quota exceeded or private browsing */
  }
}

// ── ResizeHandle ─────────────────────────────────────────────────────────────

interface ResizeHandleProps {
  /** Drag axis: 'horizontal' resizes width, 'vertical' resizes height. */
  direction: 'horizontal' | 'vertical'
  /** Current panel size in px — captured at mousedown as the starting value. */
  currentSize: number
  /** Called with the clamped new size on every drag frame. */
  onResize: (size: number) => void
  /**
   * Which side the resizable panel sits on relative to this handle.
   * 'before': panel left/above — drag right/down increases size.
   * 'after':  panel right/below — drag left/up increases size.
   * Default: 'before'.
   */
  panelSide?: 'before' | 'after'
  /** Minimum allowed size in px. Default 80. */
  min?: number
  /** Maximum allowed size in px. Default 800. */
  max?: number
  /** Called once on mouseup (drag end). Useful for persisting the final size. */
  onResizeEnd?: (size: number) => void
}

export const ResizeHandle: Component<ResizeHandleProps> = (props) => {
  const isH = props.direction === 'horizontal'

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    const startPos = isH ? e.clientX : e.clientY
    const startSize = props.currentSize
    const lo = props.min ?? 80
    const hi = props.max ?? 800
    const side = props.panelSide ?? 'before'
    let lastSize = startSize

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const pos = isH ? moveEvent.clientX : moveEvent.clientY
      const delta = pos - startPos
      lastSize = Math.max(lo, Math.min(hi, side === 'before' ? startSize + delta : startSize - delta))
      props.onResize(lastSize)
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      props.onResizeEnd?.(lastSize)
    }

    document.body.style.cursor = isH ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <div
      class={`flex-shrink-0 transition-colors ${
        isH
          ? "w-1 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50"
          : "h-1 cursor-row-resize hover:bg-blue-500/30 active:bg-blue-500/50"
      }`}
      onMouseDown={handleMouseDown}
    />
  )
}
