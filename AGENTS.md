# GraphCoder — Agent Memory

Bidirectional architectural flow & mutation platform. Digests codebases into deterministic structural graphs, layers Git history as a temporal dimension, and synthesises graph mutations back into code changes.

## Repo layout

```
packages/
  core/      @graphcoder/core    — shared TypeScript types (GraphNode, GraphEdge, etc.)
  server/    @graphcoder/server  — Express 5 + CodeGraph + WebSocket API
  client/    @graphcoder/client  — SolidJS + ELK + SVG graph canvas
test-fixtures/
  sample-project/               — small TypeScript fixture for E2E tests
```

## Stack

- **Package manager:** pnpm 11 (workspaces in `pnpm-workspace.yaml`)
- **Language:** TypeScript, strict mode, ESM (`"type": "module"` in all packages)
- **Server:** Express 5, plain HTTP (no HTTPS/certs in dev), port 3001
- **Client:** SolidJS + Vite, Tailwind CSS v4, port 3000
- **Layout:** elkjs (ELK Eclipse Layout Kernel)
- **Graph extraction:** `@colbymchenry/codegraph` v1.5.0 (tree-sitter, SQLite, 37 langs)
- **Testing:** Playwright E2E (client), Vitest unit (server/core)
- **Build:** tsdown (server/core), Vite (client)
- **Linting/format:** oxlint + oxfmt

## Commands

```bash
# Dev (both server + client)
pnpm dev

# Individual
pnpm --filter @graphcoder/server dev   # http://localhost:3001
pnpm --filter @graphcoder/client dev   # http://localhost:3000

# Type-check all
pnpm -r check

# Build all
pnpm build

# E2E tests (starts both server + client automatically)
pnpm test
# or
pnpm --filter @graphcoder/client test

# Unit tests (server + core)
pnpm test:unit
```

## Server API (http://localhost:3001)

| Method | Path                       | Description                                             |
| ------ | -------------------------- | ------------------------------------------------------- |
| GET    | `/health`                  | Server health check                                     |
| POST   | `/api/projects/open`       | Open + index a project: `{ projectRoot: string }`       |
| GET    | `/api/projects/current`    | Current open project + stats                            |
| GET    | `/api/graph`               | Full graph snapshot: `?kinds=function,class,...` filter |
| GET    | `/api/nodes/search`        | FTS symbol search: `?q=...`                             |
| GET    | `/api/nodes/:id`           | Node + edges + source code                              |
| GET    | `/api/nodes/:id/callers`   | Nodes that call this node                               |
| GET    | `/api/nodes/:id/callees`   | Nodes this node calls                                   |
| GET    | `/api/nodes/:id/impact`    | Impact radius subgraph: `?depth=3`                      |
| GET    | `/api/nodes/:id/callgraph` | Call graph subgraph: `?depth=3`                         |
| GET    | `/api/files`               | File tree with per-file node lists                      |
| POST   | `/api/sync`                | Incremental resync                                      |

WebSocket at `ws://localhost:3001/ws`:

- Sends `{ type: 'graph_snapshot', nodes: [...], edges: [...] }` on connect
- Sends `{ type: 'graph_update', nodes: [...], edges: [...] }` on file changes

## CodeGraph integration

`packages/server/src/codegraph/service.ts` — `GraphService` singleton.

- `CodeGraph.isInitialized(path)` — check for existing `.codegraph/` directory
- First open: `CodeGraph.init(path)` + `indexAll()` (slow for large projects)
- Subsequent opens: `CodeGraph.open(path)` (fast)
- Graph persists in `.codegraph/` at the project root (gitignored)
- `NODE_KINDS` from the package enumerates all node types for `getNodesByKind()`
- `getStats()` returns `{ nodeCount, edgeCount, fileCount }`

## Client architecture

```
src/
  api/graph.ts          — fetch functions for all server endpoints
  constants.ts          — shared colour maps (NODE_KIND_FILL, EDGE_KIND_STROKE, helpers)
  state/store.ts        — SolidJS createStore reactive state + action functions
    exports: visibleGraph(), toggleNodeKind(), toggleEdgeKind(), setFocus(), clearFocus(), clearFilters()
  layout/elk.ts         — ELK layout computation (async, per ViewMode)
  canvas/GraphCanvas.tsx — SVG canvas with pan/zoom, NodeRect, EdgeLine
  components/
    FilterPanel.tsx      — Left sidebar: node/edge kind toggles + focus indicator
    Toolbar.tsx          — ProjectInput + ViewModeSwitcher + SearchBar
    NodeInspector.tsx    — Selected node detail panel + Focus/Unfocus button
    SearchBar.tsx        — Symbol search with dropdown
  App.tsx               — Root layout, mounts WebSocket on load
```

## Filter & focus system

State fields: `hiddenNodeKinds: NodeKind[]`, `hiddenEdgeKinds: EdgeKind[]`, `focusedNodeId: string | null`.

`visibleGraph()` — pure function, call inside `createMemo()` or `createEffect()`. Applies:

1. Node kind filter (`hiddenNodeKinds` exclusion)
2. Individual node focus (focused node + direct neighbours from full edge set)
3. Edge kind filter (`hiddenEdgeKinds` exclusion) + both endpoints must be in visible node set

`GraphCanvas.tsx` uses `createMemo(visibleGraph)` as its layout input — filters and focus trigger re-layout automatically. Background SVG `<rect>` click clears focus (browser guarantees `onClick` doesn't fire on drag).

## CodeGraph — repo itself

The graphcoder repo has a `.codegraph/` index at its root. Use `codegraph explore` (or `mcp__codegraph__codegraph_explore` with `projectPath=/home/josh/workspaces/hexafield/graphcoder`) for structural navigation. The index auto-syncs via file watcher after `codegraph init` was run.

## Phase roadmap

| Phase | Status  | Description                                                     |
| ----- | ------- | --------------------------------------------------------------- |
| 0     | ✅ Done | Read-only graph explorer, ELK layout, SVG canvas, E2E tests     |
| 1     | Planned | ArchDiff v2 format, semantic identity layer, diff visualization |
| 2     | Planned | Temporal mapper (Git history → per-commit diffs via worktrees)  |
| 3     | Planned | Prospective state engine (in-memory graph mutations)            |
| 4     | Planned | Code synthesis engine (ArchDiff → file changes → commit loop)   |
| 5     | Planned | Flow generation (LLM-narrated source→sink flows, tethered)      |
| 6     | Planned | AI agent MCP interface                                          |

See `~/.sovereign/membranes/personal/plans/graphcoder.md` for the full design.

## Known gotchas

- **ESM imports:** Use `.js` extensions in all relative TypeScript imports (Vite/Node ESM requirement)
- **Tailwind v4:** Use `@import 'tailwindcss'` not `@tailwind base/components/utilities`
- **ELK import:** `import ELK from 'elkjs/lib/elk.bundled.js'` (bundled, no web worker)
- **CodeGraph Node 22.5+:** Required for built-in SQLite; currently on Node 26 — fine
- **pnpm build approvals:** esbuild needs `onlyBuiltDependencies[]` in `.npmrc` (already configured)
- **No HTTPS:** Dev/test uses plain HTTP on both ports; HTTPS certs removed from template
- **`skipLibCheck: true`** must stay in tsconfig (CodeGraph types require it)
