import { createMemo, createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import type { GraphEdge, GraphNode, NodeKind } from '@graphcoder/core'
import { nodeKindColor } from '../constants.js'
import {
  clearHierarchyHidden,
  globToRegex,
  setExcludePatterns,
  setHiddenPaths,
  state,
  toggleGroupExpanded,
  toggleHierarchyHidden
} from '../state/store.js'
import { resolvedTheme } from '../state/theme.js'

// ── Tree types ────────────────────────────────────────────────────────────────

interface TreeSymbol {
  type: 'symbol'
  node: GraphNode
  key: string
  children: TreeSymbol[]
}

interface TreeFile {
  type: 'file'
  node: GraphNode
  /** Key used in hiddenPaths — equals filePath so ancestor prefix checks work. */
  key: string
  children: TreeSymbol[]
}

interface TreeDir {
  type: 'dir'
  path: string
  label: string
  /** Files whose parent directory is exactly this dir's path. */
  children: TreeFile[]
  /** Subdirectories nested inside this directory. */
  subdirs: TreeDir[]
}

interface TreePackage {
  type: 'package'
  path: string
  label: string
  /** Top-level directories directly inside the package root. */
  dirs: TreeDir[]
  /** Files whose parent directory is exactly the package root path. */
  files: TreeFile[]
}

interface HierarchyTree {
  packages: TreePackage[]
  /** Top-level loose directories (not inside any recognised package). */
  dirs: TreeDir[]
  /** Files whose parent directory is the filesystem root. */
  files: TreeFile[]
}

// ── Tree builder ──────────────────────────────────────────────────────────────

const SKIP_KINDS = new Set<NodeKind>(['import', 'export'])

/**
 * Recognise monorepo-style roots: packages/, apps/, libs/, test-fixtures/,
 * fixtures/, examples/, tools/, e2e/ — anything two levels deep under these.
 */
const PKG_ROOT_RE = /^(packages|apps|libs|test-fixtures|fixtures|examples|tools|e2e)\/([^/]+)/

function pkgOf(dir: string): string | null {
  const m = PKG_ROOT_RE.exec(dir)
  return m ? m[0] : null
}

/**
 * Expand a list of leaf directory paths to include every intermediate ancestor
 * down to (but not including) `rootPath`.
 *
 * Example: given `['a/b/c/d']` and root `'a'`, produces `{'a/b', 'a/b/c', 'a/b/c/d'}`.
 * This ensures the nested tree has no gaps even when no files sit in intermediate dirs.
 */
function expandIntermediateDirs(leafDirs: Iterable<string>, rootPath: string): Set<string> {
  const result = new Set<string>()
  const prefix = rootPath === '' ? '' : rootPath + '/'
  for (const dir of leafDirs) {
    let d = dir
    while (d !== rootPath && (rootPath === '' ? d !== '' : d.startsWith(prefix))) {
      result.add(d)
      const slash = d.lastIndexOf('/')
      d = slash >= 0 ? d.slice(0, slash) : ''
    }
  }
  return result
}

/**
 * Recursively build a nested TreeDir[] from a flat set of directory paths.
 * `parentPath` identifies the immediate parent; each call returns only the
 * direct children of `parentPath` together with their own subtrees.
 */
function nestDirs(allDirs: Set<string>, parentPath: string, dirToFiles: Map<string, TreeFile[]>): TreeDir[] {
  const directChildren = [...allDirs].filter((d) => {
    const slash = d.lastIndexOf('/')
    const parent = slash >= 0 ? d.slice(0, slash) : ''
    return parent === parentPath
  })

  return directChildren.sort().map((dirPath) => ({
    type: 'dir' as const,
    path: dirPath,
    label: dirPath.split('/').pop()!,
    children: (dirToFiles.get(dirPath) ?? []).slice(),
    subdirs: nestDirs(allDirs, dirPath, dirToFiles)
  }))
}

function buildTree(nodes: GraphNode[], edges: GraphEdge[]): HierarchyTree {
  if (nodes.length === 0) return { packages: [], dirs: [], files: [] }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // Parent → [child id, ...] from contains edges
  const containsMap = new Map<string, string[]>()
  for (const e of edges) {
    if (e.kind !== 'contains') continue
    const list = containsMap.get(e.source) ?? []
    list.push(e.target)
    containsMap.set(e.source, list)
  }

  function buildSymbol(id: string): TreeSymbol | null {
    const node = nodeMap.get(id)
    if (!node || SKIP_KINDS.has(node.kind as NodeKind)) return null
    const children = (containsMap.get(id) ?? []).map(buildSymbol).filter((n): n is TreeSymbol => n !== null)
    return { type: 'symbol', node, key: node.id, children }
  }

  function buildFile(fn: GraphNode): TreeFile {
    const children = (containsMap.get(fn.id) ?? []).map(buildSymbol).filter((n): n is TreeSymbol => n !== null)
    return { type: 'file', node: fn, key: fn.filePath ?? fn.id, children }
  }

  // Group files by their immediate parent directory path
  const fileNodes = nodes.filter((n) => n.kind === 'file' || n.kind === 'module')
  const dirToFiles = new Map<string, TreeFile[]>()
  for (const fn of fileNodes) {
    const fp = (fn.filePath ?? '').replace(/\\/g, '/')
    const slash = fp.lastIndexOf('/')
    const dir = slash >= 0 ? fp.slice(0, slash) : ''
    const list = dirToFiles.get(dir) ?? []
    list.push(buildFile(fn))
    dirToFiles.set(dir, list)
  }
  for (const list of dirToFiles.values()) list.sort((a, b) => a.node.name.localeCompare(b.node.name))

  // Partition directories by package
  const pkgToLeafDirs = new Map<string, string[]>()
  const looseLeafDirs: string[] = []

  for (const dir of dirToFiles.keys()) {
    if (dir === '') continue
    const pkg = pkgOf(dir)
    if (pkg) {
      if (dir === pkg) continue // pkg root files go to pkg.files — skip as a child dir
      const list = pkgToLeafDirs.get(pkg) ?? []
      list.push(dir)
      pkgToLeafDirs.set(pkg, list)
    } else {
      looseLeafDirs.push(dir)
    }
  }

  // Build packages with properly nested dir trees
  const packages: TreePackage[] = [...pkgToLeafDirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkgPath, leafDirs]) => {
      // Expand to include any intermediate dirs that contain no files directly
      const allDirs = expandIntermediateDirs(leafDirs, pkgPath)
      return {
        type: 'package' as const,
        path: pkgPath,
        label: pkgPath.split('/').pop() ?? pkgPath,
        dirs: nestDirs(allDirs, pkgPath, dirToFiles),
        files: dirToFiles.get(pkgPath) ?? []
      }
    })

  // Build loose dir trees (dirs not belonging to any package)
  const allLooseDirs = expandIntermediateDirs(looseLeafDirs, '')

  return {
    packages,
    dirs: nestDirs(allLooseDirs, '', dirToFiles),
    files: dirToFiles.get('') ?? []
  }
}

// ── Bulk operations ───────────────────────────────────────────────────────────

/** Hide every root-level item (cascades via path-prefix to hide everything in the graph). */
function hideAll(tree: HierarchyTree): void {
  setHiddenPaths([
    ...tree.packages.map((p) => p.path),
    ...tree.dirs.map((d) => d.path),
    ...tree.files.map((f) => f.key)
  ])
}

/** Collect all dir paths from a nested TreeDir[] recursively. */
function collectDirPaths(dirs: TreeDir[]): string[] {
  const result: string[] = []
  function walk(ds: TreeDir[]) {
    for (const d of ds) {
      result.push(d.path)
      walk(d.subdirs)
    }
  }
  walk(dirs)
  return result
}

/**
 * Hide everything except `targetPath` and its descendants.
 * Peers at every level from root to target get added to hiddenPaths.
 */
function isolatePath(tree: HierarchyTree, targetPath: string): void {
  const toHide: string[] = []

  for (const pkg of tree.packages) {
    const pkgContainsTarget = pkg.path === targetPath || targetPath.startsWith(pkg.path + '/')

    if (!pkgContainsTarget) {
      toHide.push(pkg.path)
    } else {
      // Walk the full nested dir tree — hide dirs that are not ancestors of target
      for (const dirPath of collectDirPaths(pkg.dirs)) {
        if (dirPath !== targetPath && !targetPath.startsWith(dirPath + '/')) {
          toHide.push(dirPath)
        }
      }
      for (const file of pkg.files) {
        if (file.key !== targetPath && !targetPath.startsWith(file.key + '/')) {
          toHide.push(file.key)
        }
      }
    }
  }

  for (const dirPath of collectDirPaths(tree.dirs)) {
    if (dirPath !== targetPath && !targetPath.startsWith(dirPath + '/')) {
      toHide.push(dirPath)
    }
  }

  setHiddenPaths(toHide)
}

// ── Symbol kind badge ─────────────────────────────────────────────────────────

function kindBadge(kind: string): string {
  switch (kind) {
    case 'class':
    case 'struct':
      return 'C'
    case 'interface':
    case 'trait':
    case 'protocol':
      return 'I'
    case 'function':
      return 'ƒ'
    case 'method':
      return 'm'
    case 'property':
    case 'field':
      return 'p'
    case 'variable':
    case 'constant':
      return '='
    case 'enum':
      return 'E'
    case 'enum_member':
      return 'e'
    case 'type_alias':
      return 'T'
    case 'namespace':
      return 'N'
    case 'route':
      return 'R'
    case 'component':
      return '◈'
    default:
      return '·'
  }
}

// ── Eye icons ─────────────────────────────────────────────────────────────────

const EyeOpen: Component = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const EyeSlash: Component = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
)

// ── Row ───────────────────────────────────────────────────────────────────────

interface RowProps {
  depth: number
  label: string
  badge?: string
  badgeColor?: string
  expandable: boolean
  expanded: boolean
  onExpand: () => void
  hidden: boolean
  ancestorHidden: boolean
  /**
   * When true, this item matches an active exclude pattern — it will not appear
   * in the graph regardless of the manual hidden state. Rendered with a
   * strikethrough label and a static ⊘ indicator instead of the eye toggle.
   */
  excluded?: boolean
  /**
   * When true, the eye button switches to collapse/expand semantics instead of
   * hide/show. The row never dims — the file still renders as a container in
   * the graph; only its children are collapsed.
   */
  collapseMode?: boolean
  onToggleHide: (e: MouseEvent) => void
  onContextMenu?: (e: MouseEvent) => void
}

const Row: Component<RowProps> = (props) => {
  // In collapse mode the row never dims — the group container stays visible.
  const dimmed = () => !props.collapseMode && (props.hidden || props.ancestorHidden) && !props.excluded
  const eyeTitle = () =>
    props.collapseMode
      ? props.hidden
        ? 'Expand group in graph'
        : 'Collapse group in graph'
      : props.hidden
        ? 'Show in graph'
        : 'Hide from graph'
  return (
    <div class={`group flex items-center h-6 pr-1 cursor-default select-none
        hover:bg-gray-100 dark:hover:bg-gray-800/60 ${dimmed() ? 'opacity-40' : ''}`} style={{ 'padding-left': `${props.depth * 12 + 4}px` }} onContextMenu={props.onContextMenu}>
      <button
        class={`w-4 h-4 flex items-center justify-center flex-shrink-0 text-gray-400 dark:text-gray-500 ${props.expandable ? "hover:text-gray-700 dark:hover:text-gray-200" : 'pointer-events-none'}`}
        onClick={(e) => {
          e.stopPropagation()
          props.onExpand()
        }}
        tabIndex={-1}
      >
        <Show when={props.expandable}>
          <span class="text-xs leading-none">{props.expanded ? '▾' : '›'}</span>
        </Show>
      </button>

      <Show when={props.badge}>
        <span
          class="text-[9px] font-mono font-bold w-4 text-center flex-shrink-0 opacity-70"
          style={{ color: props.badgeColor }}
        >
          {props.badge}
        </span>
      </Show>

      <button
        class={`flex-1 min-w-0 text-left text-xs font-mono truncate px-1 leading-none ${
          props.excluded ? "line-through text-gray-400 dark:text-gray-600" : "text-gray-700 dark:text-gray-300"
        }`}
        onClick={props.onExpand}
      >
        {props.label}
      </button>

      {/* Excluded indicator — static, replaces eye toggle */}
      <Show
        when={!props.excluded}
        fallback={
          <span
            class="flex-shrink-0 w-5 text-center text-[10px] text-amber-400 dark:text-amber-600 opacity-70"
            title="Excluded by pattern"
          >
            ⊘
          </span>
        }
      >
        <button
          class={`flex-shrink-0 p-0.5 rounded transition-colors ${
            props.hidden
              ? "text-gray-400 dark:text-gray-500 opacity-100"
              : "text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          } hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700`}
          onClick={props.onToggleHide}
          title={eyeTitle()}
        >
          <Show when={props.hidden} fallback={<EyeOpen />}>
            <EyeSlash />
          </Show>
        </button>
      </Show>
    </div>
  )
}

// ── Recursive symbol subtree ──────────────────────────────────────────────────

interface SymbolTreeProps {
  symbols: TreeSymbol[]
  depth: number
  hiddenSet: Set<string>
  expandedSet: Set<string>
  onExpand: (key: string) => void
  ancestorHidden: boolean
}

const SymbolTree: Component<SymbolTreeProps> = (props) => {
  const isDark = () => resolvedTheme() === 'dark'

  return (
    <For each={props.symbols}>
      {(sym) => {
        const explicitlyHidden = () => props.hiddenSet.has(sym.key)
        const effectivelyHidden = () => props.ancestorHidden || explicitlyHidden()
        const expanded = () => props.expandedSet.has(sym.key)
        const hasChildren = sym.children.length > 0

        return (
          <>
            <Row
              depth={props.depth}
              label={sym.node.name}
              badge={kindBadge(sym.node.kind)}
              badgeColor={nodeKindColor(sym.node.kind, isDark())}
              expandable={hasChildren}
              expanded={expanded()}
              onExpand={() => hasChildren && props.onExpand(sym.key)}
              hidden={explicitlyHidden()}
              ancestorHidden={props.ancestorHidden}
              onToggleHide={(e) => {
                e.stopPropagation()
                toggleHierarchyHidden(sym.key)
              }}
            />
            <Show when={expanded() && hasChildren}>
              <SymbolTree
                symbols={sym.children}
                depth={props.depth + 1}
                hiddenSet={props.hiddenSet}
                expandedSet={props.expandedSet}
                onExpand={props.onExpand}
                ancestorHidden={effectivelyHidden()}
              />
            </Show>
          </>
        )
      }}
    </For>
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────

interface CtxMenuState {
  x: number
  y: number
  path: string
  label: string
}

interface CtxMenuProps {
  menu: CtxMenuState
  tree: HierarchyTree
  onClose: () => void
}

const ContextMenu: Component<CtxMenuProps> = (props) => {
  const handleOutside = (e: Event) => {
    if (!(e.target as Element).closest('[data-ctx-menu]')) props.onClose()
  }
  document.addEventListener('mousedown', handleOutside, { capture: true })
  document.addEventListener('touchstart', handleOutside, { capture: true, passive: true })
  onCleanup(() => {
    document.removeEventListener('mousedown', handleOutside, { capture: true })
    document.removeEventListener('touchstart', handleOutside, { capture: true })
  })

  const items: Array<{ label: string; action: () => void }> = [
    {
      label: 'Show just this',
      action: () => {
        isolatePath(props.tree, props.menu.path)
        props.onClose()
      }
    },
    {
      label:
        props.menu.path.length > 0 && state.hiddenPaths.includes(props.menu.path) ? 'Show in graph' : 'Hide from graph',
      action: () => {
        toggleHierarchyHidden(props.menu.path)
        props.onClose()
      }
    }
  ]

  return (
    <div
      data-ctx-menu
      class="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600
        rounded shadow-lg py-1 min-w-36"
      style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }}
    >
      <div class="px-3 py-1 text-[10px] font-mono text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-700 mb-1 truncate">
        {props.menu.label}
      </div>
      <For each={items}>
        {(item) => (
          <button
            class="w-full text-left px-3 py-1 text-xs text-gray-700 dark:text-gray-200
              hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={item.action}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  )
}

// ── HierarchyPanel ────────────────────────────────────────────────────────────

export const HierarchyPanel: Component = () => {
  const tree = createMemo(() => buildTree(state.nodes, state.edges))

  // Expand all packages by default; sync when project data changes.
  const [expandedSet, setExpandedSet] = createSignal<Set<string>>(new Set())
  createMemo(() => {
    const pkgKeys = tree().packages.map((p) => p.path)
    setExpandedSet((prev) => {
      const next = new Set(prev)
      for (const k of pkgKeys) next.add(k)
      return next
    })
  })

  const hiddenSet = createMemo(() => new Set(state.hiddenPaths))
  // When any grouping is active, eye buttons on file rows control collapse/expand
  // of the group container rather than hiding the file from the graph entirely.
  const anyGroupingOn = () => state.groupByFile || state.groupByClass || state.groupByContract || state.groupByPackage
  const expandedGroupsSet = createMemo(() => new Set(state.expandedGroups))

  // Compile active exclude patterns once per change so file rows can check membership
  const excludeRegexes = createMemo(() =>
    state.excludePatterns
      .split(',')
      .map(globToRegex)
      .filter((r): r is RegExp => r !== null)
  )
  const isExcluded = (filePath: string) => {
    const rs = excludeRegexes()
    return rs.length > 0 && rs.some((r) => r.test(filePath))
  }
  const [ctxMenu, setCtxMenu] = createSignal<CtxMenuState | null>(null)

  // ── Exclude patterns — debounced so the graph isn't refiltered on every keystroke
  const [localPatterns, setLocalPatterns] = createSignal(state.excludePatterns)
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  function handlePatternsChange(value: string) {
    setLocalPatterns(value)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setExcludePatterns(value), 300)
  }
  onCleanup(() => clearTimeout(debounceTimer))

  function toggleExpanded(key: string): void {
    setExpandedSet((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function openCtxMenu(e: MouseEvent, path: string, label: string): void {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, path, label })
  }

  const hasAnyNodes = () => tree().packages.length > 0 || tree().dirs.length > 0 || tree().files.length > 0

  // ── File rows (leaf level) ────────────────────────────────────────────────

  function renderFileRows(files: TreeFile[], depth: number, ancestorHiddenFn: () => boolean) {
    return (
      <For each={files}>
        {(file) => {
          const fileHidden = () => hiddenSet().has(file.key)
          const fileExcluded = () => isExcluded(file.key)
          const fileExpanded = () => expandedSet().has(file.key)
          const hasSymbols = file.children.length > 0

          // In group mode: eye reflects whether the group container is expanded,
          // not whether the file is hidden from the graph.
          const groupCollapsed = () => anyGroupingOn() && !expandedGroupsSet().has(file.key)

          return (
            <>
              <Row
                depth={depth}
                label={file.node.name}
                expandable={hasSymbols}
                expanded={fileExpanded()}
                onExpand={() => hasSymbols && toggleExpanded(file.key)}
                hidden={anyGroupingOn() ? groupCollapsed() : fileHidden()}
                // In group mode the row never dims — the container remains visible.
                ancestorHidden={anyGroupingOn() ? false : ancestorHiddenFn()}
                excluded={fileExcluded()}
                collapseMode={anyGroupingOn()}
                onToggleHide={(e) => {
                  e.stopPropagation()
                  if (anyGroupingOn()) {
                    toggleGroupExpanded(file.key)
                  } else {
                    toggleHierarchyHidden(file.key)
                  }
                }}
                onContextMenu={(e) => openCtxMenu(e, file.key, file.node.name)}
              />
              <Show when={fileExpanded() && hasSymbols}>
                <SymbolTree
                  symbols={file.children}
                  depth={depth + 1}
                  hiddenSet={hiddenSet()}
                  expandedSet={expandedSet()}
                  onExpand={toggleExpanded}
                  ancestorHidden={ancestorHiddenFn() || fileHidden()}
                />
              </Show>
            </>
          )
        }}
      </For>
    )
  }

  // ── Dir rows — recursive ──────────────────────────────────────────────────
  //
  // `depth` is the indentation level of the dir row itself.
  // Files inside appear at depth+1; subdirs recursively increment further.

  function renderDirRows(dirs: TreeDir[], depth: number, ancestorHiddenFn: () => boolean) {
    return (
      <For each={dirs}>
        {(dir) => {
          const dirHidden = () => hiddenSet().has(dir.path)
          const effectivelyHidden = () => ancestorHiddenFn() || dirHidden()
          const dirExpanded = () => expandedSet().has(dir.path)
          const hasContent = dir.children.length > 0 || dir.subdirs.length > 0

          return (
            <>
              <Row
                depth={depth}
                label={dir.label}
                expandable={hasContent}
                expanded={dirExpanded()}
                onExpand={() => hasContent && toggleExpanded(dir.path)}
                hidden={dirHidden()}
                ancestorHidden={ancestorHiddenFn()}
                onToggleHide={(e) => {
                  e.stopPropagation()
                  toggleHierarchyHidden(dir.path)
                }}
                onContextMenu={(e) => openCtxMenu(e, dir.path, dir.label)}
              />
              <Show when={dirExpanded() && hasContent}>
                {/* Nested subdirectories first, then files in this dir */}
                {renderDirRows(dir.subdirs, depth + 1, effectivelyHidden)}
                {renderFileRows(dir.children, depth + 1, effectivelyHidden)}
              </Show>
            </>
          )
        }}
      </For>
    )
  }

  return (
    <>
      <Show when={ctxMenu()}>
        {(menu) => <ContextMenu menu={menu()} tree={tree()} onClose={() => setCtxMenu(null)} />}
      </Show>

      <div
        class="w-60 flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700
          flex flex-col overflow-hidden"
        data-testid="hierarchy-panel"
      >
        {/* ── Header ── */}
        <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2 flex-shrink-0">
          <span class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex-1">
            Explorer
          </span>
          <Show when={hasAnyNodes()}>
            <button
              class="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white"
              onClick={() => hideAll(tree())}
              title="Hide all items from graph"
            >
              hide all
            </button>
            <span class="text-gray-300 dark:text-gray-700 text-xs">·</span>
            <button
              class="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white"
              onClick={clearHierarchyHidden}
              title="Show all hidden items"
            >
              show all
            </button>
          </Show>
        </div>

        {/* ── Exclude patterns ── */}
        <div class="px-2 pt-1.5 pb-1 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <input
            type="text"
            class="w-full text-xs font-mono bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600
              rounded px-2 py-1 text-gray-700 dark:text-gray-300 placeholder-gray-300 dark:placeholder-gray-600
              focus:outline-none focus:ring-1 focus:ring-blue-400 dark:focus:ring-blue-500"
            placeholder="*.test.ts, *.spec.*"
            value={localPatterns()}
            onInput={(e) => handlePatternsChange(e.currentTarget.value)}
            title="Comma-separated glob patterns to exclude from graph. Use * as wildcard."
          />
          <p class="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5 px-0.5 leading-tight">exclude patterns</p>
        </div>

        {/* ── Tree ── */}
        <div class="flex-1 overflow-y-auto overflow-x-hidden">
          <Show
            when={hasAnyNodes()}
            fallback={
              <div class="px-3 py-4 text-xs text-gray-400 dark:text-gray-600">
                Open a project to explore its structure.
              </div>
            }
          >
            {/* Packages */}
            <For each={tree().packages}>
              {(pkg) => {
                const pkgHidden = () => hiddenSet().has(pkg.path)
                const pkgExpanded = () => expandedSet().has(pkg.path)
                const hasContent = pkg.dirs.length > 0 || pkg.files.length > 0

                return (
                  <>
                    <Row
                      depth={0}
                      label={pkg.label}
                      expandable={hasContent}
                      expanded={pkgExpanded()}
                      onExpand={() => hasContent && toggleExpanded(pkg.path)}
                      hidden={pkgHidden()}
                      ancestorHidden={false}
                      onToggleHide={(e) => {
                        e.stopPropagation()
                        toggleHierarchyHidden(pkg.path)
                      }}
                      onContextMenu={(e) => openCtxMenu(e, pkg.path, pkg.label)}
                    />
                    <Show when={pkgExpanded() && hasContent}>
                      {renderDirRows(pkg.dirs, 1, pkgHidden)}
                      {renderFileRows(pkg.files, 1, pkgHidden)}
                    </Show>
                  </>
                )
              }}
            </For>

            {/* Loose directories (not inside a recognised package) */}
            {renderDirRows(tree().dirs, 0, () => false)}

            {/* Root-level files */}
            {renderFileRows(tree().files, 0, () => false)}
          </Show>
        </div>
      </div>
    </>
  )
}
