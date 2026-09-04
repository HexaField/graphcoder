import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { GraphCanvas } from './canvas/GraphCanvas.js'
import { AnnotationPanel } from './components/AnnotationPanel.js'
import { DiffPanel } from './components/DiffPanel.js'
import { GitGraph } from './components/GitGraph.js'
import { GraphParamsPanel } from './components/GraphParamsPanel.js'
import { HierarchyPanel } from './components/HierarchyPanel.js'
import { NodeInspector } from './components/NodeInspector.js'
import { readLayoutSize, saveLayoutSize } from './components/ResizeHandle.js'
import { Toolbar } from './components/Toolbar.js'
import type { ViewParams } from '@graphcoder/core'
import {
  clearDiff,
  connectWebSocket,
  initFromUrl,
  refilterDiffView,
  selectNode,
  sendViewRequest,
  state,
  toggleGitBar
} from './state/store.js'
import { MODE_KEYS, setInteractionMode, toggleInteractionMode } from './state/interaction.js'
// Import theme module to ensure the root-level createRoot runs on startup
import './state/theme.js'

// ── Drawer toggle strip ───────────────────────────────────────────────────────

interface DrawerToggleProps {
  side: 'left' | 'right'
  open: boolean
  onToggle: () => void
  /** Current panel width — used as starting value for resize drag. */
  currentWidth?: number
  /** Called with the clamped new width during drag. */
  onResize?: (width: number) => void
}

const DrawerToggle = (props: DrawerToggleProps) => {
  // Arrow points inward when open (toward the panel), outward when closed
  const arrow = () => {
    if (props.side === 'left') return props.open ? '‹' : '›'
    return props.open ? '›' : '‹'
  }
  const border = props.side === 'left' ? 'border-r' : 'border-l'

  // Click-vs-drag: mousedown starts tracking.  If the user releases
  // without significant movement, it's a click (toggle).  If they
  // drag, it's a resize.  This unifies toggle and resize into one strip.
  const handleMouseDown = (e: MouseEvent) => {
    // Only resize when the panel already shows and a handler exists.
    if (!props.open || !props.onResize) {
      props.onToggle()
      return
    }

    e.preventDefault()
    const startX = e.clientX
    const startWidth = props.currentWidth ?? 240
    let dragged = false

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX
      if (Math.abs(delta) > 3 || dragged) {
        dragged = true
        const newWidth = props.side === 'left' ? startWidth + delta : startWidth - delta
        props.onResize!(Math.max(120, Math.min(600, newWidth)))
      }
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (!dragged) props.onToggle()
      else {
        // Persist the final width.
        const key = props.side === 'left' ? 'leftWidth' : 'rightWidth'
        saveLayoutSize(
          key,
          props.side === 'left'
            ? startWidth + 0 // already set via onResize
            : startWidth
        )
        // Read the current signal value through onResize's last call.
        saveLayoutSize(key, props.currentWidth ?? startWidth)
      }
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      class={`hidden sm:flex w-5 flex-shrink-0 bg-gray-100 dark:bg-gray-900 ${border} border-gray-200 dark:border-gray-700
        items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-800
        text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors select-none`}
      style={{ cursor: props.open && props.onResize ? 'col-resize' : 'pointer' }}
      onMouseDown={handleMouseDown}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          props.onToggle()
        }
      }}
      title={props.open ? (props.onResize ? 'Drag to resize · click to close' : 'Close panel') : 'Open panel'}
    >
      <span class="text-xs leading-none">{arrow()}</span>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

// ── Mobile breakpoint query — shared so init + listener use the same threshold ──
const mobileMediaQuery = window.matchMedia('(max-width: 767px)')

export default function App() {
  const [isMobile, setIsMobile] = createSignal(mobileMediaQuery.matches)
  const [hierarchyOpen, setHierarchyOpen] = createSignal(!mobileMediaQuery.matches)
  const [filterOpen, setFilterOpen] = createSignal(!mobileMediaQuery.matches)
  const [annotationOpen, setAnnotationOpen] = createSignal(false)

  // ── Resizable panel widths ─────────────────────────────────────────────────
  const [leftWidth, setLeftWidth] = createSignal(readLayoutSize('leftWidth', 240))
  const [rightWidth, setRightWidth] = createSignal(readLayoutSize('rightWidth', 176))

  // Auto-open inspector when a node gets selected
  createEffect(() => {
    if (state.selectedNodeId) {
      /* NodeInspector manages its own collapsed state; selecting a node
         just ensures it mounts by revealing the outer Show guard. */
    }
  })

  // Reactive effect: send a view_request whenever any view param changes.
  // This fires once on mount (with the locally-persisted params) and again
  // on every toggle, hide, expand, or pattern change.
  //
  // When a temporal diff occupies the display, the effect also re-filters
  // the diff view locally via computeView so filters, grouping, and collapse
  // all apply to the diff — not just the live graph.
  createEffect(() => {
    const params: ViewParams = {
      hiddenNodeKinds: state.hiddenNodeKinds,
      hiddenEdgeKinds: state.hiddenEdgeKinds,
      hiddenPaths: state.hiddenPaths,
      excludePatterns: state.excludePatterns,
      groupByFile: state.groupByFile,
      groupByClass: state.groupByClass,
      groupByContract: state.groupByContract,
      groupByPackage: state.groupByPackage,
      expandedGroups: state.expandedGroups,
      focusedNodeId: state.focusedNodeId
    }
    // Re-filter the diff view when a temporal diff occupies the display.
    // No-ops when no raw diff data exists (no diff active).
    refilterDiffView(params)
    // Always send to the server — when savedView exists the WS handler
    // routes the response into savedView so the live view restores
    // correctly when the diff clears.
    sendViewRequest(params)
  })

  // Expose store snapshot for E2E testing / console diagnostics.
  ;(window as any).__graphcoder = {
    get viewNodes() {
      return state.viewNodes
    },
    get viewEdges() {
      return state.viewEdges
    },
    get viewGroups() {
      return state.viewGroups
    },
    get expandedGroups() {
      return state.expandedGroups
    },
    get savedView() {
      return state.savedView
    },
    get rawDiffView() {
      return state.rawDiffView
    },
    get diffStatusMap() {
      return state.diffStatusMap
    },
    get diffCgIdMap() {
      return state.diffCgIdMap
    },
    get gitCommits() {
      return state.gitGraph?.commits ?? []
    },
    get selectedNodeId() {
      return state.selectedNodeId
    },
    get selectedNodeDetail() {
      return state.selectedNodeDetail
    },
    get isLoadingDetail() {
      return state.isLoadingDetail
    },
    get error() {
      return state.error
    },
    get annotations() {
      return state.annotations
    },
    selectNode,
    clearDiff
  }

  onMount(() => {
    connectWebSocket()
    void initFromUrl()

    // matchMedia fires reliably in DevTools emulation, real devices, and on resize —
    // unlike window 'resize' which can miss DevTools viewport changes.
    const onMqChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mobileMediaQuery.addEventListener('change', onMqChange)

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    const handleKey = (e: KeyboardEvent) => {
      // Skip when focus is in a text input / select / textarea.
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      const lower = e.key.toLowerCase()

      if (lower === 'a') {
        setAnnotationOpen((v) => !v)
        return
      }

      if (lower in MODE_KEYS) {
        toggleInteractionMode(MODE_KEYS[lower])
        return
      }

      switch (e.key) {
        case 'H':
        case 'h':
          if (state.fileNodes.length > 0) void toggleGitBar()
          break
        case 'Escape':
          setInteractionMode('select')
          if (hierarchyOpen() && isMobile()) {
            setHierarchyOpen(false)
          } else if (filterOpen() && isMobile()) {
            setFilterOpen(false)
          } else if (state.gitBarOpen) {
            void toggleGitBar()
          } else if (state.currentDiff) {
            clearDiff()
          }
          break
      }
    }

    document.addEventListener('keydown', handleKey)
    onCleanup(() => {
      document.removeEventListener('keydown', handleKey)
      mobileMediaQuery.removeEventListener('change', onMqChange)
    })
  })

  const openHierarchy = () => {
    setHierarchyOpen(true)
    if (isMobile()) setFilterOpen(false)
  }

  const openFilter = () => {
    setFilterOpen(true)
    if (isMobile()) setHierarchyOpen(false)
  }

  return (
    <div class="flex flex-col h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white" data-testid="app">
      <Toolbar />
      <GitGraph />

      <Show when={state.error}>
        {(err) => (
          <div class="bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 px-4 py-2 text-sm flex-shrink-0">
            {err()}
          </div>
        )}
      </Show>

      {/* Mobile: semi-transparent backdrop behind open overlay panels */}
      <Show when={isMobile() && (hierarchyOpen() || filterOpen())}>
        <div
          class="fixed inset-0 bg-black/40 z-30"
          onClick={() => {
            setHierarchyOpen(false)
            setFilterOpen(false)
          }}
        />
      </Show>

      {/* ── Middle row — hierarchy | canvas | filters ── */}
      <div class="flex flex-1 overflow-hidden min-h-0 relative">
        {/* Left panel — inline on desktop, fixed overlay on mobile */}
        <Show when={!isMobile()}>
          <Show when={hierarchyOpen() || annotationOpen()}>
            <div class="flex-shrink-0 overflow-hidden flex flex-col" style={{ width: `${leftWidth()}px` }}>
              <Show when={hierarchyOpen()}>
                <div class={annotationOpen() ? "flex-1 min-h-0 overflow-hidden" : "flex-1 overflow-hidden"}>
                  <HierarchyPanel />
                </div>
              </Show>
              <Show when={annotationOpen()}>
                <Show when={hierarchyOpen()}>
                  <div class="h-px bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
                </Show>
                <div class={hierarchyOpen() ? "h-[40%] min-h-[120px] overflow-hidden" : "flex-1 overflow-hidden"}>
                  <AnnotationPanel />
                </div>
              </Show>
            </div>
          </Show>
          <DrawerToggle
            side="left"
            open={hierarchyOpen() || annotationOpen()}
            onToggle={() => {
              if (hierarchyOpen() || annotationOpen()) {
                setHierarchyOpen(false)
                setAnnotationOpen(false)
              } else {
                setHierarchyOpen(true)
              }
            }}
            currentWidth={leftWidth()}
            onResize={setLeftWidth}
          />
        </Show>
        <Show when={isMobile() && hierarchyOpen()}>
          <div
            class="fixed inset-y-0 left-0 z-40 shadow-2xl flex flex-col"
            style={{ top: '0', bottom: '0', width: '240px' }}
          >
            <HierarchyPanel />
          </div>
        </Show>

        {/* Centre column — canvas + node inspector at the bottom */}
        <div class="flex flex-col flex-1 overflow-hidden min-h-0">
          <GraphCanvas />
          <Show when={state.selectedNodeId}>
            <NodeInspector />
          </Show>
        </div>

        {/* Right panel — inline on desktop, fixed overlay on mobile */}
        <Show when={!isMobile()}>
          <DrawerToggle
            side="right"
            open={filterOpen()}
            onToggle={() => setFilterOpen((v) => !v)}
            currentWidth={rightWidth()}
            onResize={setRightWidth}
          />
          <Show when={filterOpen()}>
            <div class="flex-shrink-0 overflow-hidden" style={{ width: `${rightWidth()}px` }}>
              <GraphParamsPanel />
            </div>
          </Show>
        </Show>
        <Show when={isMobile() && filterOpen()}>
          <div
            class="fixed inset-y-0 right-0 z-40 shadow-2xl flex flex-col"
            style={{ top: '0', bottom: '0', width: '176px' }}
          >
            <GraphParamsPanel />
          </div>
        </Show>
      </div>

      {/* Mobile bottom navigation bar — CSS-controlled so it renders even if JS detection lags.
          z-50 keeps it above the backdrop (z-30) so both buttons remain tappable while a panel is open. */}
      <div
        class="flex sm:hidden items-center justify-around px-2 pt-2 bg-gray-100 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex-shrink-0 relative z-50"
        style={{ 'padding-bottom': 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <button
          class={`flex flex-col items-center gap-0.5 px-5 py-1.5 rounded-xl text-xs font-medium transition-colors ${
            hierarchyOpen()
              ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
              : "text-gray-500 dark:text-gray-400"
          }`}
          onClick={() => (hierarchyOpen() ? setHierarchyOpen(false) : openHierarchy())}
          aria-label="Toggle file explorer"
        >
          <span class="text-lg leading-none">🗂</span>
          <span>Explorer</span>
        </button>
        <button
          class={`flex flex-col items-center gap-0.5 px-5 py-1.5 rounded-xl text-xs font-medium transition-colors ${
            filterOpen()
              ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
              : "text-gray-500 dark:text-gray-400"
          }`}
          onClick={() => (filterOpen() ? setFilterOpen(false) : openFilter())}
          aria-label="Toggle graph filters"
        >
          <span class="text-lg leading-none">⚙</span>
          <span>Filters</span>
        </button>
      </div>

      {/* ── Bottom — diff panel (full width, outside middle row) ── */}
      <DiffPanel />
    </div>
  )
}
