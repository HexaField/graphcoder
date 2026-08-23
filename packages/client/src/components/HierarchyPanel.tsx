import { createMemo, createSignal, For, Show, type Component } from 'solid-js'
import type { GraphEdge, GraphNode, NodeKind } from '@graphcoder/core'
import { nodeKindColor } from '../constants.js'
import { state, toggleHierarchyHidden } from '../state/store.js'
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
  /** The key used in hiddenPaths — equals filePath so ancestor prefix checks work. */
  key: string
  children: TreeSymbol[]
}

interface TreeDir {
  type: 'dir'
  path: string
  label: string
  children: TreeFile[]
}

interface TreePackage {
  type: 'package'
  path: string
  label: string
  dirs: TreeDir[]
  files: TreeFile[]
}

interface HierarchyTree {
  packages: TreePackage[]
  dirs: TreeDir[]
  files: TreeFile[]
}

// ── Tree builder ──────────────────────────────────────────────────────────────

const SKIP_KINDS = new Set<NodeKind>(['import', 'export'])

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

  // Group files by parent directory
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

  // Extract well-known monorepo package prefixes
  function pkgOf(dir: string): string | null {
    const m = /^(packages\/[^/]+|apps\/[^/]+|libs\/[^/]+)/.exec(dir)
    return m ? m[1] : null
  }

  const pkgToDirs = new Map<string, string[]>()
  const looseDirs: string[] = []

  for (const dir of dirToFiles.keys()) {
    if (dir === '') continue
    const pkg = pkgOf(dir)
    if (pkg) {
      const list = pkgToDirs.get(pkg) ?? []
      list.push(dir)
      pkgToDirs.set(pkg, list)
    } else {
      looseDirs.push(dir)
    }
  }

  const buildDir = (dirPath: string): TreeDir => {
    const parts = dirPath.split('/')
    return {
      type: 'dir',
      path: dirPath,
      label: parts[parts.length - 1],
      children: (dirToFiles.get(dirPath) ?? []).slice()
    }
  }

  const packages: TreePackage[] = [...pkgToDirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkgPath, dirPaths]) => ({
      type: 'package',
      path: pkgPath,
      label: pkgPath.split('/').pop() ?? pkgPath,
      dirs: dirPaths.sort().map(buildDir),
      files: dirToFiles.get(pkgPath) ?? []
    }))

  return {
    packages,
    dirs: looseDirs.sort().map(buildDir),
    files: dirToFiles.get('') ?? []
  }
}

// ── Symbol kind display ───────────────────────────────────────────────────────

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

// ── Eye icons (inline SVG) ────────────────────────────────────────────────────

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

// ── Row component ─────────────────────────────────────────────────────────────

interface RowProps {
  depth: number
  label: string
  /** Badge text shown left of the label (kind indicator for symbols). */
  badge?: string
  badgeColor?: string
  /** Whether this row has children that can be expanded. */
  expandable: boolean
  expanded: boolean
  onExpand: () => void
  /** Whether this item is EXPLICITLY hidden (its key is in hiddenPaths). */
  hidden: boolean
  /** Whether any ancestor is hidden (so this row is effectively invisible in graph). */
  ancestorHidden: boolean
  onToggleHide: (e: MouseEvent) => void
}

const Row: Component<RowProps> = (props) => {
  return (
    <div class={`group flex items-center h-6 pr-1 cursor-default select-none
        hover:bg-gray-100 dark:hover:bg-gray-800/60 ${props.hidden || props.ancestorHidden ? 'opacity-40' : ''}`} style={{ 'padding-left': `${props.depth * 12 + 4}px` }}>
      {/* Expand toggle */}
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

      {/* Kind badge */}
      <Show when={props.badge}>
        <span
          class="text-[9px] font-mono font-bold w-4 text-center flex-shrink-0 opacity-70"
          style={{ color: props.badgeColor }}
        >
          {props.badge}
        </span>
      </Show>

      {/* Label */}
      <button
        class="flex-1 min-w-0 text-left text-xs font-mono truncate text-gray-700 dark:text-gray-300
          px-1 leading-none"
        onClick={props.onExpand}
      >
        {props.label}
      </button>

      {/* Eye toggle — only visible on hover or when hidden */}
      <button
        class={`flex-shrink-0 p-0.5 rounded transition-colors ${
          props.hidden
            ? "text-gray-400 dark:text-gray-500 opacity-100"
            : "text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100"
        } hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700`}
        onClick={props.onToggleHide}
        title={props.hidden ? 'Show in graph' : 'Hide from graph'}
      >
        <Show when={props.hidden} fallback={<EyeOpen />}>
          <EyeSlash />
        </Show>
      </button>
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

// ── HierarchyPanel ────────────────────────────────────────────────────────────

export const HierarchyPanel: Component = () => {
  const tree = createMemo(() => buildTree(state.nodes, state.edges))

  // All package keys expanded by default; rest collapsed
  const [expandedSet, setExpandedSet] = createSignal<Set<string>>(new Set(tree().packages.map((p) => p.path)))

  // Sync when the project changes: expand new top-level packages
  createMemo(() => {
    const pkgKeys = tree().packages.map((p) => p.path)
    setExpandedSet((prev) => {
      const next = new Set(prev)
      for (const k of pkgKeys) next.add(k)
      return next
    })
  })

  const hiddenSet = createMemo(() => new Set(state.hiddenPaths))

  function toggleExpanded(key: string): void {
    setExpandedSet((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isEmpty = () => tree().packages.length === 0 && tree().dirs.length === 0 && tree().files.length === 0

  return (
    <div
      class="w-60 flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700
        flex flex-col overflow-hidden"
      data-testid="hierarchy-panel"
    >
      {/* Header */}
      <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between flex-shrink-0">
        <span class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Explorer</span>
        <Show when={state.hiddenPaths.length > 0}>
          <button
            class="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white"
            onClick={() => {
              for (const key of [...hiddenSet()]) toggleHierarchyHidden(key)
            }}
            title="Restore all hidden items"
          >
            show all
          </button>
        </Show>
      </div>

      {/* Tree */}
      <div class="flex-1 overflow-y-auto overflow-x-hidden">
        <Show
          when={!isEmpty()}
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
              const hasDirs = pkg.dirs.length > 0
              const hasFiles = pkg.files.length > 0

              return (
                <>
                  {/* Package row */}
                  <Row
                    depth={0}
                    label={pkg.label}
                    expandable={hasDirs || hasFiles}
                    expanded={pkgExpanded()}
                    onExpand={() => toggleExpanded(pkg.path)}
                    hidden={pkgHidden()}
                    ancestorHidden={false}
                    onToggleHide={(e) => {
                      e.stopPropagation()
                      toggleHierarchyHidden(pkg.path)
                    }}
                  />

                  <Show when={pkgExpanded()}>
                    {/* Files directly in package root */}
                    <For each={pkg.files}>
                      {(file) => {
                        const fileHidden = () => hiddenSet().has(file.key)
                        const fileAncestorHidden = () => pkgHidden()
                        const fileExpanded = () => expandedSet().has(file.key)
                        const hasSymbols = file.children.length > 0

                        return (
                          <>
                            <Row
                              depth={1}
                              label={file.node.name}
                              expandable={hasSymbols}
                              expanded={fileExpanded()}
                              onExpand={() => hasSymbols && toggleExpanded(file.key)}
                              hidden={fileHidden()}
                              ancestorHidden={fileAncestorHidden()}
                              onToggleHide={(e) => {
                                e.stopPropagation()
                                toggleHierarchyHidden(file.key)
                              }}
                            />
                            <Show when={fileExpanded() && hasSymbols}>
                              <SymbolTree
                                symbols={file.children}
                                depth={2}
                                hiddenSet={hiddenSet()}
                                expandedSet={expandedSet()}
                                onExpand={toggleExpanded}
                                ancestorHidden={fileAncestorHidden() || fileHidden()}
                              />
                            </Show>
                          </>
                        )
                      }}
                    </For>

                    {/* Directories */}
                    <For each={pkg.dirs}>
                      {(dir) => {
                        const dirHidden = () => hiddenSet().has(dir.path)
                        const dirAncestorHidden = () => pkgHidden()
                        const dirExpanded = () => expandedSet().has(dir.path)

                        return (
                          <>
                            <Row
                              depth={1}
                              label={dir.label}
                              expandable={dir.children.length > 0}
                              expanded={dirExpanded()}
                              onExpand={() => toggleExpanded(dir.path)}
                              hidden={dirHidden()}
                              ancestorHidden={dirAncestorHidden()}
                              onToggleHide={(e) => {
                                e.stopPropagation()
                                toggleHierarchyHidden(dir.path)
                              }}
                            />

                            <Show when={dirExpanded()}>
                              <For each={dir.children}>
                                {(file) => {
                                  const fileHidden = () => hiddenSet().has(file.key)
                                  const fileAncestorHidden = () => dirAncestorHidden() || dirHidden()
                                  const fileExpanded = () => expandedSet().has(file.key)
                                  const hasSymbols = file.children.length > 0

                                  return (
                                    <>
                                      <Row
                                        depth={2}
                                        label={file.node.name}
                                        expandable={hasSymbols}
                                        expanded={fileExpanded()}
                                        onExpand={() => hasSymbols && toggleExpanded(file.key)}
                                        hidden={fileHidden()}
                                        ancestorHidden={fileAncestorHidden()}
                                        onToggleHide={(e) => {
                                          e.stopPropagation()
                                          toggleHierarchyHidden(file.key)
                                        }}
                                      />
                                      <Show when={fileExpanded() && hasSymbols}>
                                        <SymbolTree
                                          symbols={file.children}
                                          depth={3}
                                          hiddenSet={hiddenSet()}
                                          expandedSet={expandedSet()}
                                          onExpand={toggleExpanded}
                                          ancestorHidden={fileAncestorHidden() || fileHidden()}
                                        />
                                      </Show>
                                    </>
                                  )
                                }}
                              </For>
                            </Show>
                          </>
                        )
                      }}
                    </For>
                  </Show>
                </>
              )
            }}
          </For>

          {/* Loose directories (not inside a recognised package) */}
          <For each={tree().dirs}>
            {(dir) => {
              const dirHidden = () => hiddenSet().has(dir.path)
              const dirExpanded = () => expandedSet().has(dir.path)

              return (
                <>
                  <Row
                    depth={0}
                    label={dir.label}
                    expandable={dir.children.length > 0}
                    expanded={dirExpanded()}
                    onExpand={() => toggleExpanded(dir.path)}
                    hidden={dirHidden()}
                    ancestorHidden={false}
                    onToggleHide={(e) => {
                      e.stopPropagation()
                      toggleHierarchyHidden(dir.path)
                    }}
                  />

                  <Show when={dirExpanded()}>
                    <For each={dir.children}>
                      {(file) => {
                        const fileHidden = () => hiddenSet().has(file.key)
                        const fileExpanded = () => expandedSet().has(file.key)
                        const hasSymbols = file.children.length > 0

                        return (
                          <>
                            <Row
                              depth={1}
                              label={file.node.name}
                              expandable={hasSymbols}
                              expanded={fileExpanded()}
                              onExpand={() => hasSymbols && toggleExpanded(file.key)}
                              hidden={fileHidden()}
                              ancestorHidden={dirHidden()}
                              onToggleHide={(e) => {
                                e.stopPropagation()
                                toggleHierarchyHidden(file.key)
                              }}
                            />
                            <Show when={fileExpanded() && hasSymbols}>
                              <SymbolTree
                                symbols={file.children}
                                depth={2}
                                hiddenSet={hiddenSet()}
                                expandedSet={expandedSet()}
                                onExpand={toggleExpanded}
                                ancestorHidden={dirHidden() || fileHidden()}
                              />
                            </Show>
                          </>
                        )
                      }}
                    </For>
                  </Show>
                </>
              )
            }}
          </For>

          {/* Root-level files (no directory) */}
          <For each={tree().files}>
            {(file) => {
              const fileHidden = () => hiddenSet().has(file.key)
              const fileExpanded = () => expandedSet().has(file.key)
              const hasSymbols = file.children.length > 0

              return (
                <>
                  <Row
                    depth={0}
                    label={file.node.name}
                    expandable={hasSymbols}
                    expanded={fileExpanded()}
                    onExpand={() => hasSymbols && toggleExpanded(file.key)}
                    hidden={fileHidden()}
                    ancestorHidden={false}
                    onToggleHide={(e) => {
                      e.stopPropagation()
                      toggleHierarchyHidden(file.key)
                    }}
                  />
                  <Show when={fileExpanded() && hasSymbols}>
                    <SymbolTree
                      symbols={file.children}
                      depth={1}
                      hiddenSet={hiddenSet()}
                      expandedSet={expandedSet()}
                      onExpand={toggleExpanded}
                      ancestorHidden={fileHidden()}
                    />
                  </Show>
                </>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}
