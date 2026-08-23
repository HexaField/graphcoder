import { type Component, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { GraphNode, NodeKind } from '@graphcoder/core'
import { nodeSemanticId } from '@graphcoder/core'
import { edgeKindColor, nodeKindColor } from '../constants.js'
import {
  layoutGraph,
  type FileGroup,
  type FileContainer,
  type LayoutEdge,
  type LayoutNode,
  type LayoutResult
} from '../layout/elk.js'
import { clearFocus, selectNode, state, visibleGraph } from '../state/store.js'

// ── Package container draw helper ─────────────────────────────────────────────

function drawPackageContainer(target: Container, container: FileContainer, isDark: boolean): void {
  const { x, y, width, height, label } = container
  const g = new Graphics()

  // Outermost tier — slightly more prominent than dir containers
  g.roundRect(0, 0, width, height, 18)
  g.fill({ color: isDark ? 0x020710 : 0xcdd5e0, alpha: isDark ? 0.5 : 0.35 })
  g.roundRect(0, 0, width, height, 18)
  g.stroke({ color: isDark ? 0x1e3a5f : 0x64748b, width: 1.5, alpha: isDark ? 0.6 : 0.45 })

  g.position.set(x, y)
  target.addChild(g)

  const labelStyle = new TextStyle({
    fontSize: 11,
    fill: isDark ? '#4b6a8a' : '#475569',
    fontFamily: 'monospace',
    fontWeight: 'bold'
  })
  const text = new Text({ text: label.toUpperCase(), style: labelStyle })
  text.position.set(x + 16, y + 10)
  target.addChild(text)
}
import { resolvedTheme } from '../state/theme.js'

// ── Types ─────────────────────────────────────────────────────────────────────

type DiffStatus = 'added' | 'modified' | 'moved' | 'none'

interface OverlayNode {
  id: string
  name: string
  left: number
  top: number
  width: number
  height: number
}

interface DrawColors {
  isDark: boolean
  nameStyle: TextStyle
  badgeStyle: TextStyle
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function diffStatusColor(status: DiffStatus): string {
  if (status === 'added') return '#22c55e'
  if (status === 'modified') return '#f59e0b'
  if (status === 'moved') return '#06b6d4'
  return 'transparent'
}

function nodeDiffStatus(
  semId: string | null,
  overlay: { added: Set<string>; modified: Set<string>; moved: Set<string> }
): DiffStatus {
  if (!semId) return 'none'
  if (overlay.added.has(semId)) return 'added'
  if (overlay.modified.has(semId)) return 'modified'
  if (overlay.moved.has(semId)) return 'moved'
  return 'none'
}

/** Destroy all direct children of a container and release GPU resources. */
function clearContainer(c: Container): void {
  const removed = c.removeChildren()
  for (const child of removed) {
    child.destroy(true) // true = destroy textures + children recursively
  }
}

// ── Shared text styles — allocated once per module ────────────────────────────

const NAME_STYLE_DARK = new TextStyle({ fontSize: 11, fill: '#ffffff', fontFamily: 'monospace' })
const NAME_STYLE_LIGHT = new TextStyle({ fontSize: 11, fill: '#0f172a', fontFamily: 'monospace' })
const BADGE_STYLE_DARK = new TextStyle({ fontSize: 8, fill: '#9ca3af', fontFamily: 'monospace' })
const BADGE_STYLE_LIGHT = new TextStyle({ fontSize: 8, fill: '#475569', fontFamily: 'monospace' })
const CONTAINER_LABEL_STYLE_DARK = new TextStyle({ fontSize: 9, fill: '#6b7280', fontFamily: 'monospace' })
const CONTAINER_LABEL_STYLE_LIGHT = new TextStyle({ fontSize: 9, fill: '#94a3b8', fontFamily: 'monospace' })
const DIR_LABEL_STYLE_DARK = new TextStyle({ fontSize: 10, fill: '#374151', fontFamily: 'monospace' })
const DIR_LABEL_STYLE_LIGHT = new TextStyle({ fontSize: 10, fill: '#64748b', fontFamily: 'monospace' })

// ── Contract group definitions ────────────────────────────────────────────────
//
// Each entry defines a semantic API surface layer. Nodes match the FIRST group
// whose test() returns true (priority order). Groups without filePath are used
// as contract groups — they produce flat 2-tier ELK compound layout rather than
// the directory-nested layout used by file grouping.

interface ContractGroupDef {
  id: string
  label: string
  color: string
  test: (node: GraphNode) => boolean
}

const ROUTE_KINDS: NodeKind[] = ['route']

/**
 * API boundary contract groups — only external protocol surfaces qualify.
 * Internal groupings (data models, services, UI components) use the hierarchy
 * panel or file/class grouping instead.
 */
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

function makeColors(isDark: boolean): DrawColors {
  return {
    isDark,
    nameStyle: isDark ? NAME_STYLE_DARK : NAME_STYLE_LIGHT,
    badgeStyle: isDark ? BADGE_STYLE_DARK : BADGE_STYLE_LIGHT
  }
}

// ── Draw functions ────────────────────────────────────────────────────────────

function drawDirContainer(target: Container, container: FileContainer, isDark: boolean): void {
  const { x, y, width, height, label } = container
  const g = new Graphics()

  // Lighter, more transparent background than file containers
  g.roundRect(0, 0, width, height, 14)
  g.fill({ color: isDark ? 0x060c18 : 0xdde4ef, alpha: isDark ? 0.4 : 0.4 })

  // Subtler border — slightly larger radius, lower alpha
  g.roundRect(0, 0, width, height, 14)
  g.stroke({ color: isDark ? 0x1e2d40 : 0x94a3b8, width: 1, alpha: isDark ? 0.45 : 0.35 })

  g.position.set(x, y)
  target.addChild(g)

  // Directory path label at top-left
  const labelStyle = isDark ? DIR_LABEL_STYLE_DARK : DIR_LABEL_STYLE_LIGHT
  const short = label.length > 48 ? `…${label.slice(-47)}` : label
  const text = new Text({ text: short, style: labelStyle })
  text.position.set(x + 12, y + 8)
  target.addChild(text)
}

function drawFileContainer(target: Container, container: FileContainer, isDark: boolean): void {
  const { x, y, width, height, label, color } = container
  const g = new Graphics()

  if (color) {
    // Contract group container — coloured accent border with tinted background
    const hex = parseInt(color.slice(1), 16)
    g.roundRect(0, 0, width, height, 10)
    g.fill({ color: hex, alpha: 0.07 })
    g.roundRect(0, 0, width, height, 10)
    g.stroke({ color: hex, width: 2, alpha: 0.6 })
  } else {
    // File container — neutral slate
    g.roundRect(0, 0, width, height, 8)
    g.fill({ color: isDark ? 0x0f172a : 0xe2e8f0, alpha: isDark ? 0.55 : 0.5 })
    g.roundRect(0, 0, width, height, 8)
    g.stroke({ color: isDark ? 0x334155 : 0x94a3b8, width: 1.5, alpha: isDark ? 0.8 : 0.6 })
  }

  g.position.set(x, y)
  target.addChild(g)

  if (color) {
    // Contract group label — contract color, bold, full name (not truncated)
    const contractStyle = new TextStyle({ fontSize: 11, fill: color, fontFamily: 'monospace', fontWeight: 'bold' })
    const text = new Text({ text: label, style: contractStyle })
    text.position.set(x + 12, y + 10)
    target.addChild(text)
  } else {
    // File label — muted monospace, trimmed to last 31 chars
    const labelStyle = isDark ? CONTAINER_LABEL_STYLE_DARK : CONTAINER_LABEL_STYLE_LIGHT
    const short = label.length > 32 ? `…${label.slice(-31)}` : label
    const text = new Text({ text: short, style: labelStyle })
    text.position.set(x + 10, y + 10)
    target.addChild(text)
  }
}

function drawEdge(target: Container, edge: LayoutEdge, colors: DrawColors): void {
  const pts: number[] = []
  for (const section of edge.sections) {
    pts.push(section.startPoint.x, section.startPoint.y)
    for (const bp of section.bendPoints ?? []) {
      pts.push(bp.x, bp.y)
    }
    pts.push(section.endPoint.x, section.endPoint.y)
  }
  if (pts.length < 4) return

  const color = edgeKindColor(edge.kind, colors.isDark)
  const g = new Graphics()

  // Polyline
  g.moveTo(pts[0], pts[1])
  for (let i = 2; i < pts.length; i += 2) {
    g.lineTo(pts[i], pts[i + 1])
  }
  g.stroke({ color, width: 1.5, alpha: 0.6 })

  // Filled arrowhead at the end point
  const n = pts.length
  const ex = pts[n - 2]
  const ey = pts[n - 1]
  const px = pts[n - 4]
  const py = pts[n - 3]
  const angle = Math.atan2(ey - py, ex - px)
  const aLen = 8
  g.moveTo(ex, ey)
  g.lineTo(ex - aLen * Math.cos(angle - 0.4), ey - aLen * Math.sin(angle - 0.4))
  g.lineTo(ex - aLen * Math.cos(angle + 0.4), ey - aLen * Math.sin(angle + 0.4))
  g.closePath()
  g.fill(color)

  target.addChild(g)
}

function drawNode(
  target: Container,
  layoutNode: LayoutNode,
  graphNode: GraphNode | undefined,
  selected: boolean,
  diffStatus: DiffStatus,
  colors: DrawColors
): void {
  const { x, y, width, height } = layoutNode
  const { isDark, nameStyle, badgeStyle } = colors
  const g = new Graphics()

  // Diff overlay ring (behind fill)
  if (diffStatus !== 'none') {
    g.roundRect(-3, -3, width + 6, height + 6, 6)
    g.stroke({ color: diffStatusColor(diffStatus), width: 2.5, alpha: 0.85 })
  }

  // Node background
  g.roundRect(0, 0, width, height, 4)
  g.fill(nodeKindColor(graphNode?.kind, isDark))

  // Selection border — re-define path so fill and stroke stay independent
  if (selected) {
    g.roundRect(0, 0, width, height, 4)
    g.stroke({ color: '#3b82f6', width: 2 })
  }

  g.position.set(x, y)
  target.addChild(g)

  // Kind badge — right-aligned
  const badgeStr = graphNode?.kind ?? ''
  if (badgeStr) {
    const badge = new Text({ text: badgeStr, style: badgeStyle })
    badge.anchor.set(1, 0)
    badge.position.set(x + width - 4, y + 2)
    target.addChild(badge)
  }

  // Name label — left edge, vertically centred
  const rawName = graphNode?.name ?? layoutNode.id
  const label = rawName.length > 18 ? `${rawName.slice(0, 16)}…` : rawName
  const nameText = new Text({ text: label, style: nameStyle })
  nameText.anchor.set(0, 0.5)
  nameText.position.set(x + 8, y + height / 2)
  target.addChild(nameText)
}

// ── GraphCanvas ───────────────────────────────────────────────────────────────

export const GraphCanvas: Component = () => {
  const [layout, setLayout] = createSignal<LayoutResult | null>(null)
  const [isLayouting, setIsLayouting] = createSignal(false)
  // Single source of truth for camera; drives both Pixi world container
  // and the DOM hit-test overlay via reactive effects.
  const [camera, setCamera] = createSignal({ tx: 0, ty: 0, scale: 1 })
  // pixiReady gates all Pixi writes. Must be a signal so effects
  // re-evaluate when Pixi finishes its async init.
  const [pixiReady, setPixiReady] = createSignal(false)

  let canvasRef: HTMLCanvasElement | undefined
  let wrapperRef: HTMLDivElement | undefined
  // Plain refs — written once in onMount; never reactive.
  // We access them in effects already gated by pixiReady().
  let pixiApp: Application | null = null
  let worldContainer: Container | null = null
  let packageGroupLayer: Container | null = null // package containers — outermost background (4-tier)
  let dirGroupLayer: Container | null = null // directory containers — second background layer
  let groupLayer: Container | null = null // file + contract container boxes
  let classGroupLayer: Container | null = null // class sub-containers (inside file containers)
  let edgeLayer: Container | null = null
  let nodeLayer: Container | null = null

  // ── Reactive memos ──────────────────────────────────────────────────────────

  const visible = createMemo(visibleGraph)
  const nodeById = createMemo(() => new Map(state.nodes.map((n) => [n.id, n])))

  const diffOverlay = createMemo(() => {
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
   * Unified compound group memo — composes all three grouping modes simultaneously.
   *
   * Priority / structure:
   *   1. Contract groups (groupByContract) claim matching nodes first; they
   *      carry no filePath so ELK places them as flat root compounds alongside
   *      the dir compounds.
   *   2. File groups (groupByFile) get the remaining nodes. When groupByClass
   *      is ALSO on, class nodes become childGroups (sub-compounds) inside each
   *      file group; methods/properties inside them become leaf nodes of the class
   *      sub-group rather than the file group.
   *   3. When ONLY groupByClass is on (no file grouping), class nodes become
   *      top-level groups with filePath — ELK places them inside dir compounds.
   *   4. Package groups (groupByPackage) wrap dir compounds as the outermost tier
   *      when combined with groupByFile (4-tier). Without groupByFile they produce
   *      flat root compounds, one per package.
   */
  const combinedGroups = createMemo((): FileGroup[] | undefined => {
    const gf = state.groupByFile
    const gc = state.groupByClass
    const gct = state.groupByContract
    const gp = state.groupByPackage

    if (!gf && !gc && !gct && !gp) return undefined

    /** Extract 'packages/server' from 'packages/server/src/routes/graph.ts'. */
    function extractPackagePath(fp?: string): string | undefined {
      if (!fp) return undefined
      const m = fp.match(/^(packages\/[^/]+)/)
      return m?.[1]
    }

    const visibleNodeIds = new Set(visible().nodes.map((n) => n.id))

    // Build one-level contains-children index (direct children only)
    const containsChildren = new Map<string, string[]>()
    for (const e of state.edges) {
      if (e.kind !== 'contains') continue
      let ch = containsChildren.get(e.source)
      if (!ch) containsChildren.set(e.source, (ch = []))
      ch.push(e.target)
    }

    // Recursive descendant collection for file grouping
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

    const groups: FileGroup[] = []
    const claimedByContract = new Set<string>()

    // ── 1. Contract groups ─────────────────────────────────────────────────
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
        // No filePath → flat root compound (not inside a dir container)
        groups.push({ id: def.id, label: def.label, color: def.color, childIds })
      }
    }

    // ── 2a. File groups (with optional class sub-groups) ───────────────────
    if (gf) {
      const fileNodes = state.nodes.filter((n) => n.kind === 'file')

      for (const fn of fileNodes) {
        const allDesc = new Set<string>()
        collectDescendants(fn.id, allDesc)
        // Remove contract-claimed nodes from the file group
        for (const id of claimedByContract) allDesc.delete(id)

        if (gc) {
          // Build class sub-groups for direct class children of this file
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
            childGroups.push({
              id: classId,
              label: classNode.name,
              color: '#818cf8',
              childIds: classChildIds
            })
          }

          // Remaining visible descendants that didn't end up in a class sub-group
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
          // File groups without class sub-grouping — all descendants as leaves
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
      // ── 2b. Class groups only (no file grouping) ───────────────────────
      const classNodes = state.nodes.filter((n) => n.kind === 'class')
      for (const cn of classNodes) {
        const childIds = (containsChildren.get(cn.id) ?? []).filter(
          (id) => visibleNodeIds.has(id) && !claimedByContract.has(id)
        )
        if (childIds.length === 0) continue
        // filePath → placed inside dir compound by ELK
        groups.push({ id: cn.id, label: cn.name, filePath: cn.filePath, color: '#818cf8', childIds })
      }
    }

    // ── 3. Package-only groups (groupByPackage without groupByFile) ────────
    // When file grouping is also active, packagePath on each file group (above)
    // triggers the 4-tier ELK path instead. This branch handles the standalone
    // case — one flat compound per package, all visible package nodes inside it.
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
        const label = pkg.split('/').pop() ?? pkg
        // Flat root compound — treated like a contract group (no filePath)
        // Rendered in groupLayer (neutral file-container style, no color)
        groups.push({ id: `__pkg_${label}`, label, childIds })
      }
    }

    return groups.length > 0 ? groups : undefined
  })

  // Overlay positions: camera × ELK layout → CSS pixel rects for each node.
  // Updates on every pan/zoom and every layout change.
  const overlayNodes = createMemo((): OverlayNode[] => {
    const l = layout()
    if (!l) return []
    const { tx, ty, scale } = camera()
    const byId = nodeById()
    return [...l.nodes.values()].map((n) => ({
      id: n.id,
      name: byId.get(n.id)?.name ?? n.id,
      left: n.x * scale + tx,
      top: n.y * scale + ty,
      width: n.width * scale,
      height: n.height * scale
    }))
  })

  // ── ELK layout effect ───────────────────────────────────────────────────────
  // Only computes layout. Camera fit lives in a separate effect so it can
  // wait for pixiReady without coupling to the ELK async lifecycle.

  createEffect(async () => {
    const { nodes, edges } = visible()
    const viewMode = state.viewMode
    const groups = combinedGroups() // reactive: re-layouts when any grouping mode changes
    if (nodes.length === 0) {
      setLayout(null)
      return
    }
    setIsLayouting(true)
    try {
      const result = await layoutGraph(nodes, edges, viewMode, groups)
      setLayout(result)
    } finally {
      setIsLayouting(false)
    }
  })

  // ── Camera fit effect ───────────────────────────────────────────────────────
  // Fires whenever layout changes AND Pixi has initialised. Separating this
  // from the ELK effect means the fit is always applied after WebGL is ready,
  // regardless of which completes first (Pixi init vs ELK).

  createEffect(() => {
    if (!pixiReady()) return // waits for Pixi; re-runs when it's ready
    const l = layout()
    if (!l) return
    const pad = 40
    const cw = canvasRef?.clientWidth ?? 800
    const ch = canvasRef?.clientHeight ?? 600
    const scale = Math.min(cw / (l.width + pad), ch / (l.height + pad))
    setCamera({
      tx: (cw - l.width * scale) / 2,
      ty: (ch - l.height * scale) / 2,
      scale
    })
  })

  // ── Pixi background effect ──────────────────────────────────────────────────
  // Updates the WebGL clear color when the resolved theme changes.

  createEffect(() => {
    if (!pixiReady() || !pixiApp) return
    const isDark = resolvedTheme() === 'dark'
    pixiApp.renderer.background.color = isDark ? 0x030712 : 0xf1f5f9
  })

  // ── Pixi draw effect ────────────────────────────────────────────────────────
  // Full scene redraw on layout, selection, diff change, or theme change.
  // Camera changes alone do NOT trigger this — worldContainer.position handles
  // those without needing a GPU re-upload.

  createEffect(() => {
    if (
      !pixiReady() ||
      !packageGroupLayer ||
      !dirGroupLayer ||
      !groupLayer ||
      !classGroupLayer ||
      !edgeLayer ||
      !nodeLayer
    )
      return
    const l = layout()
    const selectedId = state.selectedNodeId
    const overlay = diffOverlay()
    const byId = nodeById()
    const colors = makeColors(resolvedTheme() === 'dark') // reactive: redraws on theme change

    clearContainer(packageGroupLayer)
    clearContainer(dirGroupLayer)
    clearContainer(groupLayer)
    clearContainer(classGroupLayer)
    clearContainer(edgeLayer)
    clearContainer(nodeLayer)
    if (!l) return

    // Draw package containers (outermost background — 4-tier only)
    for (const pc of l.packageContainers) {
      drawPackageContainer(packageGroupLayer, pc, colors.isDark)
    }

    // Draw directory containers above package backgrounds
    for (const dc of l.dirContainers) {
      drawDirContainer(dirGroupLayer, dc, colors.isDark)
    }

    // Draw file and contract container boxes above directory backgrounds
    for (const container of l.containers) {
      drawFileContainer(groupLayer, container, colors.isDark)
    }

    // Draw class sub-containers inside file containers
    for (const cc of l.classContainers) {
      drawFileContainer(classGroupLayer, cc, colors.isDark)
    }

    for (const edge of l.edges) {
      drawEdge(edgeLayer, edge, colors)
    }
    for (const layoutNode of l.nodes.values()) {
      const graphNode = byId.get(layoutNode.id)
      const semId = state.currentDiff && graphNode ? nodeSemanticId(graphNode) : null
      const diffStatus = nodeDiffStatus(semId, overlay)
      drawNode(nodeLayer, layoutNode, graphNode, selectedId === layoutNode.id, diffStatus, colors)
    }
  })

  // ── Camera sync ─────────────────────────────────────────────────────────────
  // Keeps the Pixi world container in sync with the camera signal.
  // Tracks pixiReady() so this fires once on Pixi init (applying whatever
  // camera value is already set) and on every subsequent setCamera call.

  createEffect(() => {
    if (!pixiReady() || !worldContainer) return
    const { tx, ty, scale } = camera()
    worldContainer.position.set(tx, ty)
    worldContainer.scale.set(scale)
  })

  // ── Pixi init ───────────────────────────────────────────────────────────────

  onMount(async () => {
    if (!canvasRef) return

    const isDark = resolvedTheme() === 'dark'
    const app = new Application()
    await app.init({
      canvas: canvasRef,
      resizeTo: canvasRef.parentElement ?? undefined,
      background: isDark ? 0x030712 : 0xf1f5f9,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true
    })

    // Build scene graph: world → [package, dir, file, class containers, edges, nodes]
    const wc = new Container()
    const pgl = new Container() // package group layer — outermost bounding boxes (4-tier)
    const dgl = new Container() // dir group layer — directory bounding boxes
    const gl = new Container() // group layer — file + contract container boxes
    const cgl = new Container() // class group layer — class sub-container boxes
    const el = new Container()
    const nl = new Container()
    wc.addChild(pgl, dgl, gl, cgl, el, nl)
    app.stage.addChild(wc)

    pixiApp = app
    worldContainer = wc
    packageGroupLayer = pgl
    dirGroupLayer = dgl
    groupLayer = gl
    classGroupLayer = cgl
    edgeLayer = el
    nodeLayer = nl

    // Signal to gated effects that Pixi is now usable
    setPixiReady(true)

    // Wheel zoom — listener on the wrapper div so it fires whether the cursor is
    // over the canvas or over a transparent overlay node button.
    // passive:false required to call preventDefault() and stop page scroll.
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvasRef!.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const sensitivity = e.deltaMode === 0 ? 0.002 : 0.08
      const factor = Math.exp(-e.deltaY * sensitivity)
      setCamera((c) => ({
        scale: c.scale * factor,
        tx: cx - (cx - c.tx) * factor,
        ty: cy - (cy - c.ty) * factor
      }))
    }
    wrapperRef!.addEventListener('wheel', handleWheel, { passive: false })

    onCleanup(() => {
      wrapperRef?.removeEventListener('wheel', handleWheel)
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
      pixiApp = null
      worldContainer = null
      packageGroupLayer = null
      dirGroupLayer = null
      groupLayer = null
      classGroupLayer = null
      edgeLayer = null
      nodeLayer = null
      app.destroy()
    })
  })

  // ── Pan ──────────────────────────────────────────────────────────────────────
  // onMouseDown lives on the wrapper div (not the canvas) so it fires for
  // clicks on both the canvas AND overlay node buttons. Pixi v8 registers its
  // own pointerdown listener on the canvas which can mask mousedown; the wrapper
  // div is outside Pixi's event scope so it receives events reliably.
  //
  // Distinguishing pan-start from node-click is not needed: if the user
  // presses + releases without dragging, the camera barely moves and the
  // button's onClick fires normally. If they drag, click doesn't fire on
  // the button (browser suppresses click after significant movement).

  const onWindowMouseMove = (e: MouseEvent) => {
    // movementX/Y are in CSS logical pixels — direct 1:1 to camera tx/ty
    setCamera((c) => ({ ...c, tx: c.tx + e.movementX, ty: c.ty + e.movementY }))
  }

  const onWindowMouseUp = () => {
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
  }

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    // onMouseDown on wrapper: receives events from canvas AND overlay buttons
    // onClick/clearFocus stays on canvas so it only fires for background clicks
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

      {/* WebGL canvas — all rendering.
          data-testid="graph-svg" kept for E2E backward compat.
          onClick handles background-click → clearFocus (node buttons use
          stopPropagation so they don't trigger this). */}
      <canvas ref={canvasRef} class="block w-full h-full" data-testid="graph-svg" onClick={clearFocus} />

      {/* Invisible DOM overlay: one transparent button per node.
          Container is pointer-events:none (background clicks reach canvas).
          Each button is pointer-events:auto for tests + screen readers. */}
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <For each={overlayNodes()}>
          {(n) => (
            <button
              class="absolute opacity-0 pointer-events-auto"
              style={{
                left: `${n.left}px`,
                top: `${n.top}px`,
                width: `${n.width}px`,
                height: `${n.height}px`
              }}
              data-nodeid={n.id}
              data-testid={`node-${n.id}`}
              onClick={(e) => {
                e.stopPropagation()
                void selectNode(n.id)
              }}
              aria-label={n.name}
            />
          )}
        </For>
      </div>
    </div>
  )
}
