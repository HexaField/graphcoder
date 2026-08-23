/**
 * GraphCanvas — SolidJS wrapper around ThreeRenderer.
 *
 * Maintains the same reactive interface as the old PixiJS implementation:
 *   - ELK layout effect (layout changes on visible graph / direction / group changes)
 *   - Camera fit on first layout
 *   - Scene update effect (selection, diff overlay, theme)
 *   - Pan/zoom via wheel + mouse drag
 *   - Click hit testing via RBush (no DOM overlay buttons)
 *
 * Keyboard interaction preserved in App.tsx (H=toggle git bar, Esc=clear diff).
 * Node click: detected in onMouseDown/onClick pair via hit test.
 */

import { type Component, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { GraphNode, NodeKind } from '@graphcoder/core'
import type { FileGroup } from '../layout/elk.js'
import { layoutGraph, type LayoutResult } from '../layout/elk.js'
import { clearFocus, selectNode, state, visibleGraph } from '../state/store.js'
import { resolvedTheme } from '../state/theme.js'
import type { DiffOverlay } from './ThreeRenderer.js'
import { ThreeRenderer } from './ThreeRenderer.js'

// ── Contract group definitions (unchanged from PixiJS version) ────────────────

interface ContractGroupDef {
  id: string
  label: string
  color: string
  test: (node: GraphNode) => boolean
}

const ROUTE_KINDS: NodeKind[] = ['route']

const CONTRACT_GROUPS: ContractGroupDef[] = [
  {
    id: '__contract_rest',
    label: 'REST API',
    color: '#10b981',
    test: (n) =>
      (ROUTE_KINDS as string[]).includes(n.kind) ||
      /\.(controller|router|route|handler|endpoint)\.[jt]sx?$/i.test(n.filePath ?? '') ||
      /[\\/](controllers?|routes?|handlers?|endpoints?)[\\/]/i.test(n.filePath ?? '')
  },
  {
    id: '__contract_ws',
    label: 'WebSocket',
    color: '#06b6d4',
    test: (n) =>
      /\.(gateway|socket|hub|ws)\.[jt]sx?$/i.test(n.filePath ?? '') ||
      /[\\/](gateways?|sockets?|hubs?)[\\/]/i.test(n.filePath ?? '')
  },
  {
    id: '__contract_graphql',
    label: 'GraphQL',
    color: '#e879f9',
    test: (n) =>
      /\.(resolver|typedef)\.[jt]sx?$/i.test(n.filePath ?? '') ||
      /\.(graphql|gql)$/i.test(n.filePath ?? '') ||
      /[\\/](resolvers?|graphql)[\\/]/i.test(n.filePath ?? '') ||
      /(Query|Mutation|Subscription|Resolver)$/.test(n.name)
  }
]

// ── GraphCanvas ───────────────────────────────────────────────────────────────

export const GraphCanvas: Component = () => {
  const [isLayouting, setIsLayouting] = createSignal(false)
  // Camera state: pan offset (world coords → screen) + zoom
  const [cam, setCam] = createSignal({ panX: 0, panY: 0, zoom: 1 })
  const [rendererReady, setRendererReady] = createSignal(false)
  const [layoutError, setLayoutError] = createSignal<string | null>(null)

  let canvasRef: HTMLCanvasElement | undefined
  let wrapperRef: HTMLDivElement | undefined
  let r3: ThreeRenderer | null = null

  // Track whether the current layout has been camera-fitted already.
  // Reset to false on each layout change so we only auto-fit once.
  let needsFit = false

  // ── Reactive memos ──────────────────────────────────────────────────────────

  const visible = createMemo(visibleGraph)
  const nodeById = createMemo(() => new Map(state.nodes.map((n) => [n.id, n])))

  const diffOverlay = createMemo((): DiffOverlay => {
    const diff = state.currentDiff
    if (!diff) return { added: new Set<string>(), modified: new Set<string>(), moved: new Set<string>() }
    const added = new Set<string>()
    const modified = new Set<string>()
    const moved = new Set<string>()
    for (const op of diff.operations) {
      if (op.op === 'add_node') added.add(op.node.id)
      else if (op.op === 'modify_node') modified.add(op.id)
      else if (op.op === 'move_node') moved.add(op.id)
    }
    return { added, modified, moved }
  })

  /**
   * Unified compound group memo — composes file, class, contract, and package
   * grouping simultaneously.
   *
   * Returns `{ groups, collapsedChildIds }` where `collapsedChildIds` is the
   * set of node IDs that belong inside collapsed group containers and must be
   * excluded from the flat node list passed to ELK. Returns `undefined` when
   * no grouping is active.
   */
  const combinedGroups = createMemo((): { groups: FileGroup[]; collapsedChildIds: Set<string> } | undefined => {
    const gf = state.groupByFile
    const gc = state.groupByClass
    const gct = state.groupByContract
    const gp = state.groupByPackage

    if (!gf && !gc && !gct && !gp) return undefined

    function extractPackagePath(fp?: string): string | undefined {
      if (!fp) return undefined
      const m = fp.match(/^(packages\/[^/]+)/)
      return m?.[1]
    }

    const visibleNodeIds = new Set(visible().nodes.map((n) => n.id))

    const containsChildren = new Map<string, string[]>()
    for (const e of state.edges) {
      if (e.kind !== 'contains') continue
      let ch = containsChildren.get(e.source)
      if (!ch) containsChildren.set(e.source, (ch = []))
      ch.push(e.target)
    }

    function collectDescendants(nodeId: string, out: Set<string>): void {
      for (const child of containsChildren.get(nodeId) ?? []) {
        out.add(child)
        collectDescendants(child, out)
      }
    }

    function fileLabel(fn: GraphNode): string {
      const name = fn.name
      return name && !name.includes('/') ? name : ((fn.filePath ?? name ?? fn.id).split('/').pop() ?? fn.id)
    }

    /**
     * Check whether a file group at the given filePath should show its children
     * expanded. Uses prefix matching: a dir or package path in expandedGroups
     * expands all files under it.
     *
     * Groups without a filePath (contract groups, package-only groups) always
     * expand — they have no HierarchyPanel eye-button link.
     */
    function isGroupExpanded(filePath?: string): boolean {
      if (!filePath) return true
      return state.expandedGroups.some((prefix) => filePath === prefix || filePath.startsWith(prefix + '/'))
    }

    const groups: FileGroup[] = []
    const claimedByContract = new Set<string>()
    // Nodes inside collapsed group containers — excluded from the ELK node list.
    const collapsedChildIds = new Set<string>()

    // 1. Contract groups (no collapse support — no HierarchyPanel 1-1 link)
    if (gct) {
      const visibleNodes = visible().nodes
      const assigned = new Set<string>()
      for (const def of CONTRACT_GROUPS) {
        const childIds = visibleNodes.filter((n) => !assigned.has(n.id) && def.test(n)).map((n) => n.id)
        if (childIds.length === 0) continue
        childIds.forEach((id) => {
          assigned.add(id)
          claimedByContract.add(id)
        })
        groups.push({ id: def.id, label: def.label, color: def.color, childIds })
      }
    }

    // 2a. File groups (with optional class sub-groups)
    if (gf) {
      const fileNodes = state.nodes.filter((n) => n.kind === 'file')
      for (const fn of fileNodes) {
        const allDesc = new Set<string>()
        collectDescendants(fn.id, allDesc)
        for (const id of claimedByContract) allDesc.delete(id)

        const expanded = isGroupExpanded(fn.filePath)

        if (!expanded) {
          // Collapsed: exclude all visible descendants from ELK, push empty container.
          const visibleChildIds = [...allDesc].filter((id) => visibleNodeIds.has(id))
          if (visibleChildIds.length === 0) continue // nothing to show or collapse
          for (const id of visibleChildIds) collapsedChildIds.add(id)
          groups.push({
            id: fn.id,
            label: fileLabel(fn),
            childIds: [],
            childGroups: undefined,
            filePath: fn.filePath,
            packagePath: gp ? extractPackagePath(fn.filePath) : undefined
          })
          continue
        }

        // Expanded: build child lists as normal.
        if (gc) {
          const childGroups: FileGroup[] = []
          const assignedToClass = new Set<string>()
          for (const classId of containsChildren.get(fn.id) ?? []) {
            const classNode = state.nodes.find((n) => n.id === classId && n.kind === 'class')
            if (!classNode) continue
            const classChildIds = (containsChildren.get(classId) ?? []).filter(
              (id) => visibleNodeIds.has(id) && !claimedByContract.has(id)
            )
            if (classChildIds.length === 0) continue
            classChildIds.forEach((id) => assignedToClass.add(id))
            childGroups.push({ id: classId, label: classNode.name, color: '#818cf8', childIds: classChildIds })
          }
          const leafIds = [...allDesc].filter((id) => visibleNodeIds.has(id) && !assignedToClass.has(id))
          if (leafIds.length === 0 && childGroups.length === 0) continue
          groups.push({
            id: fn.id,
            label: fileLabel(fn),
            childIds: leafIds,
            childGroups: childGroups.length > 0 ? childGroups : undefined,
            filePath: fn.filePath,
            packagePath: gp ? extractPackagePath(fn.filePath) : undefined
          })
        } else {
          const childIds = [...allDesc].filter((id) => visibleNodeIds.has(id))
          if (childIds.length === 0) continue
          groups.push({
            id: fn.id,
            label: fileLabel(fn),
            childIds,
            filePath: fn.filePath,
            packagePath: gp ? extractPackagePath(fn.filePath) : undefined
          })
        }
      }
    } else if (gc) {
      // 2b. Class groups only (collapse keyed to the class's filePath)
      const classNodes = state.nodes.filter((n) => n.kind === 'class')
      for (const cn of classNodes) {
        const childIds = (containsChildren.get(cn.id) ?? []).filter(
          (id) => visibleNodeIds.has(id) && !claimedByContract.has(id)
        )
        if (childIds.length === 0) continue
        const expanded = isGroupExpanded(cn.filePath)
        if (!expanded) {
          for (const id of childIds) collapsedChildIds.add(id)
          groups.push({ id: cn.id, label: cn.name, filePath: cn.filePath, color: '#818cf8', childIds: [] })
        } else {
          groups.push({ id: cn.id, label: cn.name, filePath: cn.filePath, color: '#818cf8', childIds })
        }
      }
    }

    // 3. Package-only groups (no collapse — no filePath link)
    if (gp && !gf) {
      const visibleNodes = visible().nodes
      const pkgMap = new Map<string, string[]>()
      for (const n of visibleNodes) {
        if (claimedByContract.has(n.id)) continue
        const pkg = extractPackagePath(n.filePath)
        if (!pkg) continue
        if (!pkgMap.has(pkg)) pkgMap.set(pkg, [])
        pkgMap.get(pkg)!.push(n.id)
      }
      for (const [pkg, childIds] of pkgMap) {
        if (childIds.length === 0) continue
        groups.push({ id: `__pkg_${pkg.split('/').pop() ?? pkg}`, label: pkg.split('/').pop() ?? pkg, childIds })
      }
    }

    return groups.length > 0 ? { groups, collapsedChildIds } : undefined
  })

  // ── ELK layout effect ───────────────────────────────────────────────────────

  const [layout, setLayout] = createSignal<LayoutResult | null>(null)

  createEffect(async () => {
    const { nodes, edges } = visible()
    const direction = state.graphDirection
    const grouped = combinedGroups()
    const groups = grouped?.groups
    const collapsedChildIds = grouped?.collapsedChildIds

    if (nodes.length === 0) {
      setLayout(null)
      setLayoutError(null)
      return
    }

    // Exclude child nodes that belong inside collapsed group containers —
    // they must not appear as free-floating ELK nodes outside their container.
    const layoutNodes =
      collapsedChildIds && collapsedChildIds.size > 0 ? nodes.filter((n) => !collapsedChildIds.has(n.id)) : nodes

    setIsLayouting(true)
    setLayoutError(null)
    needsFit = true
    try {
      const result = await layoutGraph(layoutNodes, edges, direction, groups)
      setLayout(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[GraphCanvas] Layout failed:', err)
      setLayoutError(msg)
    } finally {
      setIsLayouting(false)
    }
  })

  // ── Scene update effect ─────────────────────────────────────────────────────
  // Fires on layout, selection, diff, or theme change.

  createEffect(() => {
    if (!rendererReady() || !r3) return
    const l = layout()
    const selectedId = state.selectedNodeId
    const overlay = diffOverlay()
    const byId = nodeById()
    const isDark = resolvedTheme() === 'dark'

    r3.setBackground(isDark ? 0x030712 : 0xf1f5f9)

    if (!l) return

    // Auto-fit on first layout (or after re-layout)
    if (needsFit) {
      needsFit = false
      const fit = r3.fitLayout(l.width, l.height)
      setCam({ panX: fit.panX, panY: fit.panY, zoom: fit.zoom })
      r3.applyCamera(fit.panX, fit.panY, fit.zoom)
    }

    r3.updateScene(l, byId, selectedId, overlay, isDark)
  })

  // ── Camera sync effect ──────────────────────────────────────────────────────

  createEffect(() => {
    if (!rendererReady() || !r3) return
    const { panX, panY, zoom } = cam()
    r3.applyCamera(panX, panY, zoom)
    r3.render()
  })

  // ── Theme background sync ───────────────────────────────────────────────────

  createEffect(() => {
    if (!rendererReady() || !r3) return
    r3.setBackground(resolvedTheme() === 'dark' ? 0x030712 : 0xf1f5f9)
    r3.render()
  })

  // ── Mount: init Three.js renderer ──────────────────────────────────────────

  onMount(() => {
    if (!canvasRef || !wrapperRef) return

    const renderer = new ThreeRenderer(canvasRef)
    r3 = renderer

    const w = canvasRef.clientWidth || wrapperRef.clientWidth || 800
    const h = canvasRef.clientHeight || wrapperRef.clientHeight || 600
    renderer.resize(w, h)
    renderer.setBackground(resolvedTheme() === 'dark' ? 0x030712 : 0xf1f5f9)
    renderer.render()

    setRendererReady(true)

    // ── ResizeObserver ──────────────────────────────────────────────────────
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect
        if (width > 0 && height > 0) {
          renderer.resize(width, height)
          renderer.render()
        }
      }
    })
    ro.observe(wrapperRef)

    // ── Wheel zoom ─────────────────────────────────────────────────────────
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvasRef!.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const sens = e.deltaMode === 0 ? 0.002 : 0.08
      const factor = Math.exp(-e.deltaY * sens)
      setCam((c) => ({
        zoom: c.zoom * factor,
        panX: cx - (cx - c.panX) * factor,
        panY: cy - (cy - c.panY) * factor
      }))
    }
    wrapperRef.addEventListener('wheel', handleWheel, { passive: false })

    // ── Touch: single-finger pan, two-finger pinch-zoom, tap-to-select ─────
    let activeTouches: Touch[] = []
    let pinchDist = 0
    let touchMoved = false

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault()
      activeTouches = Array.from(e.touches)
      touchMoved = false
      if (activeTouches.length === 2) {
        pinchDist = Math.hypot(
          activeTouches[0].clientX - activeTouches[1].clientX,
          activeTouches[0].clientY - activeTouches[1].clientY
        )
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault()
      const curr = Array.from(e.touches)
      if (curr.length === 1 && activeTouches.length >= 1) {
        const dx = curr[0].clientX - activeTouches[0].clientX
        const dy = curr[0].clientY - activeTouches[0].clientY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) touchMoved = true
        setCam((c) => ({ ...c, panX: c.panX + dx, panY: c.panY + dy }))
      } else if (curr.length === 2 && activeTouches.length >= 2) {
        touchMoved = true
        const newDist = Math.hypot(curr[0].clientX - curr[1].clientX, curr[0].clientY - curr[1].clientY)
        if (pinchDist > 0) {
          const factor = newDist / pinchDist
          const rect = canvasRef!.getBoundingClientRect()
          const cx = (curr[0].clientX + curr[1].clientX) / 2 - rect.left
          const cy = (curr[0].clientY + curr[1].clientY) / 2 - rect.top
          setCam((c) => ({
            zoom: c.zoom * factor,
            panX: cx - (cx - c.panX) * factor,
            panY: cy - (cy - c.panY) * factor
          }))
        }
        pinchDist = newDist
      }
      activeTouches = curr
    }

    const handleTouchEnd = (e: TouchEvent) => {
      // Tap-to-select: single touch, minimal movement, all fingers lifted
      if (!touchMoved && activeTouches.length === 1 && e.touches.length === 0) {
        const touch = activeTouches[0]
        const rect = canvasRef!.getBoundingClientRect()
        const sx = touch.clientX - rect.left
        const sy = touch.clientY - rect.top
        const { panX, panY, zoom } = cam()
        if (r3) {
          const nodeId = r3.hitTest(sx, sy, panX, panY, zoom)
          if (nodeId) void selectNode(nodeId)
          else clearFocus()
        }
      }
      activeTouches = Array.from(e.touches)
      if (activeTouches.length === 0) touchMoved = false
    }

    wrapperRef.addEventListener('touchstart', handleTouchStart, { passive: false })
    wrapperRef.addEventListener('touchmove', handleTouchMove, { passive: false })
    wrapperRef.addEventListener('touchend', handleTouchEnd)

    onCleanup(() => {
      ro.disconnect()
      wrapperRef?.removeEventListener('wheel', handleWheel)
      wrapperRef?.removeEventListener('touchstart', handleTouchStart)
      wrapperRef?.removeEventListener('touchmove', handleTouchMove)
      wrapperRef?.removeEventListener('touchend', handleTouchEnd)
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
      renderer.dispose()
      r3 = null
    })
  })

  // ── Pan via mouse drag ──────────────────────────────────────────────────────

  let dragMoved = false // distinguish drag from click

  const onWindowMouseMove = (e: MouseEvent) => {
    dragMoved = true
    setCam((c) => ({ ...c, panX: c.panX + e.movementX, panY: c.panY + e.movementY }))
  }

  const onWindowMouseUp = () => {
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
  }

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    dragMoved = false
    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
  }

  // ── Click: hit-test via RBush ───────────────────────────────────────────────

  const handleClick = (e: MouseEvent) => {
    if (dragMoved) return // suppress click at end of a drag
    if (!r3) {
      clearFocus()
      return
    }
    const rect = canvasRef!.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const { panX, panY, zoom } = cam()
    const nodeId = r3.hitTest(sx, sy, panX, panY, zoom)
    if (nodeId) {
      void selectNode(nodeId)
    } else {
      clearFocus()
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      ref={wrapperRef}
      class="relative w-full h-full overflow-hidden select-none"
      data-testid="graph-canvas"
      onMouseDown={handleMouseDown}
    >
      <Show when={isLayouting()}>
        <div class="absolute inset-0 flex items-center justify-center text-gray-500 dark:text-gray-400 z-10 pointer-events-none">
          <span>Computing layout…</span>
        </div>
      </Show>
      <Show when={state.nodes.length === 0 && !state.isLoading}>
        <div class="absolute inset-0 flex items-center justify-center text-gray-400 dark:text-gray-500 pointer-events-none">
          <span>No project open. Enter a project path above.</span>
        </div>
      </Show>

      <Show when={layoutError() !== null}>
        {(err) => (
          <div class="absolute bottom-0 left-0 right-0 z-10 px-4 py-2 bg-red-50 dark:bg-red-950 border-t border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-300 pointer-events-none flex items-center gap-2">
            <span>⚠ Layout error:</span>
            <span class="truncate">{err()}</span>
          </div>
        )}
      </Show>

      {/*
        data-testid="graph-svg" kept for E2E backward compatibility.
        onClick replaces the DOM button overlay for node selection.
      */}
      <canvas ref={canvasRef} class="block w-full h-full" data-testid="graph-svg" onClick={handleClick} />
    </div>
  )
}
