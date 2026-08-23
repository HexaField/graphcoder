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
| POST   | `/api/projects/close`      | Close current project (test state reset)                |
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

## HTTP Bridge

`packages/server/src/codegraph/http-bridge.ts` — custom analysis layer that bridges the HTTP boundary.

CodeGraph cannot link `fetch()` calls to route handlers because the URL is a runtime string. The bridge:

1. Scans all TS/JS source files for `fetch()` calls using a character-level state machine (handles nested `${...}` in template literals without truncation).
2. Normalises URL templates: strips base-URL variable prefix + API mount path (e.g. `/api`), replaces `/${encodeURIComponent(x)}` → `/:x`, strips query strings and trailing `${params}` suffixes.
3. Matches normalised (method, path) against route nodes — most-specific routes sorted first (fewer `:param` segments, then longer paths) to mirror Express first-match-wins.
4. Finds the narrowest containing function/method for the fetch call line via per-file line-range index.
5. Produces synthetic `Edge` objects with `provenance: 'heuristic'` and `metadata.synthetic: true`.

`GraphService` caches synthetic edges in `this.httpEdges` — refreshed on `open()` and after `POST /sync`. `getAllNodesAndEdges()` merges them (deduped). `getIncomingEdgesAugmented()` / `getOutgoingEdgesAugmented()` augment per-node queries (used by `/nodes/:id`, `/nodes/:id/callers`, `/nodes/:id/callees`).

**Gotcha:** The look-ahead for HTTP method detection is capped at the next `fetch(` occurrence to prevent a later `method: 'POST'` from contaminating earlier same-file fetch calls that have no options object.

## Client architecture

```
src/
  api/graph.ts          — fetch functions for all server endpoints
  constants.ts          — shared colour maps (NODE_KIND_FILL, EDGE_KIND_STROKE, helpers)
  state/store.ts        — SolidJS createStore reactive state + action functions
    exports: visibleGraph(), captureSnapshot(), clearDiff(), toggleNodeKind(),
             toggleEdgeKind(), setFocus(), clearFocus(), clearFilters()
  layout/elk.ts         — ELK layout computation (async, per ViewMode)
  canvas/GraphCanvas.tsx — SVG canvas with pan/zoom, NodeRect, EdgeLine, diff overlay rings
  components/
    DiffPanel.tsx        — Bottom bar: diff summary + collapsible op list
    FilterPanel.tsx      — Left sidebar: node/edge kind toggles + focus indicator
    Toolbar.tsx          — ProjectInput + ViewModeSwitcher + SearchBar + Snapshot controls
    NodeInspector.tsx    — Selected node detail panel + Focus/Unfocus button
    SearchBar.tsx        — Symbol search with dropdown
  App.tsx               — Root layout, mounts WebSocket on load
```

## ArchDiff v2 + Semantic Identity (Phase 1)

`packages/core/src/identity.ts` — `semanticId(kind, name, sig?)` → 64-char hex sha256. Stable across file moves; breaks on rename or kind-change. `nodeSemanticId(node)` convenience wrapper.

`packages/core/src/diff/` — composable graph delta format:

- `types.ts` — `ArchDiff { version:2, base, target, diffHash, operations: ArchOp[] }`. Op union: `add_node | remove_node | modify_node | move_node | add_edge | remove_edge`
- `hash.ts` — `canonicalJson()`, `snapshotHash()` (nodes sorted by semId), `computeDiffHash()`
- `compute.ts` — `computeArchDiff(base, target)`: move detection (same semId, different filePath), rename heuristic (same kind+file+startLine±5 → `renameOf` annotation), canonical op ordering (remove_edge → remove_node → modify_node → move_node → add_node → add_edge)
- `apply.ts` — `applyArchDiff(snapshot, diff)`: validates base hash, applies ops in canonical order
- `compose.ts` — `compose(ab, bc)`: folding rules (add+remove=cancel, add+modify=folded-add, modify+modify=merged, move+move=collapsed, edge cancel)

Client diff state (`store.ts`): `baseSnapshot: GraphSnapshot | null`, `currentDiff: ArchDiff | null`.  
Actions: `captureSnapshot()`, `clearDiff()`. Auto-recomputes on every WS graph update.

`DiffPanel.tsx` — summary bar (green=added, red=removed, amber=modified, cyan=moved) + collapsible op list. Testids: `diff-panel`, `diff-toggle`, `clear-diff-btn`.

`GraphCanvas.tsx` — diff overlay rings per node via `createMemo` over `diffOverlay`. Color: green=added, amber=modified, cyan=moved.

`Toolbar.tsx` — `snapshot-btn` (shown when project open + no snapshot), `clear-diff-toolbar-btn` (shown when snapshot active).

Server: `POST /api/projects/close` — closes current project for test state reset.

Test fixtures: `test-fixtures/project-v1/` + `test-fixtures/project-v2/` — deliberate rename/move/add/remove across 3 TS files for diff round-trip E2E tests.

**Gotcha:** `test-fixtures/**/.codegraph` gitignored — stale index (0 nodes) causes `[data-nodeid]` to never render in E2E tests. Delete `.codegraph/` from any fixture to force re-index.

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
| 1     | ✅ Done | ArchDiff v2 format, semantic identity layer, diff visualization |
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
