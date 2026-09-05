# GraphCoder — Agent Memory

Bidirectional architectural flow & mutation platform. Digests codebases into deterministic structural graphs, layers Git history as a temporal dimension, and synthesises graph mutations back into code changes.

## Stack

- **Package manager:** pnpm 11 (workspaces)
- **Language:** TypeScript, strict ESM (`"type": "module"` throughout)
- **Server:** Express 5, port 3357
- **Client:** SolidJS + Vite + Tailwind v4, port 3356
- **Layout:** elkjs (ELK Eclipse Layout Kernel)
- **Canvas renderer:** Three.js (WebGL2) — `packages/client/src/canvas/`
- **Graph extraction:** `@colbymchenry/codegraph` v1.5.0 (tree-sitter + SQLite, 37 languages)
- **Testing:** Playwright E2E (client), Vitest unit (server/core)
- **Build:** tsdown (server/core), Vite (client)
- **Linting/format:** oxlint + oxfmt (pre-commit hooks)

## Commands

```bash
pnpm dev                                  # start both server + client
pnpm --filter @graphcoder/server dev      # server only (http://localhost:3357)
pnpm --filter @graphcoder/client dev      # client only (http://localhost:3356)
pnpm build                                # build all packages
pnpm -r check                             # type-check all
pnpm test                                 # Playwright E2E (auto-starts server + client)
pnpm test:unit                            # Vitest unit tests (server + core)
```

## Ports

Client `3356`, server `3357` — deliberately high in the range, since 3000/3001 collide with almost every other dev server. Override with `PORT` (both packages) or `VITE_API_URL` / `VITE_WS_URL` (client).

Four files hold the defaults; changing a port means editing the matching pair, not hunting literals:

| File                              | Holds                                       |
| --------------------------------- | ------------------------------------------- |
| `packages/server/src/index.ts`    | `DEFAULT_PORT` — the API port               |
| `packages/client/src/config.ts`   | `DEFAULT_API_PORT` + all client API/WS URLs |
| `packages/client/vite.config.ts`  | `DEFAULT_CLIENT_PORT` — dev/preview port    |
| `packages/client/tests/config.ts` | Both ports for the E2E suite                |

Client code must import `API_BASE` / `WS_URL` from `src/config.ts` rather than composing its own URL — the host is taken from `window.location` so a single build works on localhost, a LAN, or through a tunnel.

## HTTP Bridge

`packages/server/src/codegraph/http-bridge.ts` — custom analysis layer that bridges the HTTP boundary.

CodeGraph cannot link `fetch()` calls to route handlers because the URL is a runtime string. The bridge:

1. Scans all TS/JS source files for `fetch()` calls using a character-level state machine (handles nested `${...}` in template literals without truncation).
2. Normalises URL templates: strips base-URL variable prefix + API mount path (`/api`), replaces `/${encodeURIComponent(x)}` → `/:x`, strips query strings and trailing `${params}` suffixes.
3. Matches normalised (method, path) against route nodes — most-specific routes sorted first (fewer `:param` segments, then longer paths) to mirror Express first-match-wins.
4. Finds the narrowest containing function/method for the fetch call line via per-file line-range index.
5. Produces synthetic `Edge` objects with `provenance: 'heuristic'` and `metadata.synthetic: true`.

`GraphService` caches synthetic edges in `this.httpEdges` — refreshed on `open()` and after `POST /api/sync`. `getAllNodesAndEdges()` merges them (deduped). `getIncomingEdgesAugmented()` / `getOutgoingEdgesAugmented()` augment per-node queries.

**Gotcha:** The look-ahead for HTTP method detection is capped at the next `fetch(` occurrence to prevent a later `method: 'POST'` from contaminating earlier same-file fetch calls that have no options object.

## Phase roadmap

| Phase | Status  | Description                                                                       |
| ----- | ------- | --------------------------------------------------------------------------------- |
| 0     | ✅ Done | Read-only graph explorer, ELK layout, Pixi.js canvas, E2E tests                   |
| 1     | ✅ Done | ArchDiff v2 format, semantic identity layer, diff visualization                   |
| 2     | ✅ Done | Temporal mapper (Git history → per-commit diffs via worktrees, SQLite cache, SSE) |
| —     | ✅ Done | Three.js WebGL renderer replacing PixiJS (5 draw calls, handles 10k+ nodes)       |
| 3     | ✅ Done | Annotation surface — draw-to-annotate, user-defined kinds, AI proposals           |
| 3c    | ✅ Done | Consumer tooling — CLI, MCP server, PR stack UI                                   |
| 4     | Planned | Projections (speculative sketching, projected ArchDiffs, git graph integration)   |
| 5     | Planned | Prospective state engine (projections → CoW graph forks)                          |
| 6     | Planned | Code synthesis engine (projection → ArchDiff → file changes → commit)             |
| 7     | Planned | AI agent MCP interface (agents create annotations + projections)                  |

See `~/.sovereign/membranes/personal/plans/graphcoder.md` for the full design.

## Canvas renderer (Three.js)

`packages/client/src/canvas/` contains:

- `ThreeRenderer.ts` — WebGL renderer class; 5 draw calls regardless of graph size:
  1. `containerMesh` — InstancedBufferGeometry for all container boxes (package/dir/file/class)
  2. `edgeLines` — LineSegments2 (three/addons) for all edge polylines at 2px screen-space width
  3. `nodeMesh` — InstancedBufferGeometry for all node boxes; per-instance diff/selection state
  4. `arrowMesh` — InstancedBufferGeometry for arrowhead triangles
  5. `glyphMesh` — InstancedBufferGeometry for SDF glyph quads (all text in one call)
- `sdfAtlas.ts` — builds a single-channel SDF atlas from `@mapbox/tiny-sdf` for printable ASCII; RGBA DataTexture with SDF in alpha; `flipY=true` + inverted V coords
- `shaders.ts` — GLSL ES 1.0 vertex/fragment shaders for rect (rounded-rect SDF), glyph (atlas sample), and arrow (rotated triangle)
- `GraphCanvas.tsx` — SolidJS wrapper; `OrthographicCamera` with Y-down convention matching ELK; pan/zoom via World Group transform; `RBush` R-tree for hit testing (no DOM overlay)

**Minimal DOM overlays** — hover hit-testing via RBush in world coordinates; expand/collapse button on hovered containers is a positioned HTML `<button>` (`container-expand-btn`) above the canvas.

## Annotation model (schema v2)

Annotations carry two independent axes. Do not conflate them.

- **`shape`** — how it was drawn. Fixed vocabulary: `region | polyline | point`. Drives rendering only.
- **`kind`** — what it means. A free-form user-defined string; `''` means unkinded. Carries no behaviour.

The user never picks a shape from a menu — the drawing gesture in `GraphCanvas.tsx` decides it:

| Gesture                       | Shape      | Members captured                      |
| ----------------------------- | ---------- | ------------------------------------- |
| Drag starting on empty canvas | `region`   | Node centres inside the lasso polygon |
| Drag starting on a node       | `polyline` | Nodes crossed, **in crossing order**  |
| Click with no drag            | `point`    | The node under the cursor, if any     |

`members` is a single ordered array of semantic IDs for every shape. **Order is significant for `polyline`** — it is the traversal. There is no parallel `steps`/`stepEdges` structure (v1 had one; v2 collapsed it).

`geometry` holds the drawn stroke in world coordinates: `{ points: [x,y][], anchor: {x,y} }`.

### Kind registry

`.graphcoder/annotation-kinds.json` — `{ name, color, description, createdAt }[]`, committed with the repo. Kinds are created on first use: typing a name that does not exist registers it with a hash-stable palette colour. Names match case-insensitively but keep the case first typed.

- `ensureKind()` runs on every annotation create/patch, so a kind can never be referenced without being registered.
- `GET /api/annotation-kinds` calls `syncKindsFromAnnotations()`, which registers any kind found on an annotation but missing from the file — this covers hand-edited files and AI-coined kinds.
- Renaming a kind via `PATCH /api/annotation-kinds/:name` rewrites every annotation using it. Deleting a kind only unregisters it; annotations keep the string and fall back to neutral grey.

### Migration

`normalizeAnnotation()` in `packages/core/src/annotations/store.ts` migrates on read. Anything without a `shape` field is treated as v1: `boundary|projection → region`, `path → polyline` (ordered members taken from `steps[].architectureNodeId`), `note|question → point`. The old kind name survives as the v2 free-form kind, so no meaning is lost. Retired v1 statuses (`draft`, `applied`, `resolved`) collapse to `active`.

### IDE surfaces

- `A` enters draw mode; `Shift+A` toggles the annotation panel; `Esc` cancels.
- `⌘/Ctrl+K` opens `CommandPalette.tsx` (subsequence fuzzy match over commands, annotations, and kinds).
- `⌘/Ctrl+Z` / `⇧⌘Z` — undo/redo. The stack lives in `state/annotations.ts`; entries record create/delete/update snapshots and replay through the same API the UI uses.
- `KindInput.tsx` is the only naming surface — inline at the shape anchor, never a modal.

## CLI (`@graphcoder/cli`)

`packages/cli/` — standalone CLI for CI and agent use. Commands:

```bash
graphcoder check [path]          # annotation health — reports stale member references
graphcoder digest [path] --json  # structured annotation digest grouped by kind
graphcoder import-prs --base dev --tip feature-branch  # import PR stack as proposed annotations
```

Exit codes: 0 = success, 1 = issues found, 2 = error. Requires `.graphcoder/` (CodeGraph index) in the project.

## MCP server (`@graphcoder/mcp`)

`packages/mcp/` — wraps CLI commands as MCP tools over stdio transport.

Tools: `graphcoder_check`, `graphcoder_digest`, `graphcoder_import_prs`. Each takes `projectRoot` (absolute path). The import tool also takes `base` and `tip` git refs.

Run with `node packages/mcp/dist/index.js` or register in MCP config as `graphcoder-mcp`.

## PR stack UI

`PrStackBar` — horizontal bar below the canvas showing stacked PRs as coloured segments. Click a segment to select that PR. `← →` keys step through the stack. "Import" button converts the stack into proposed annotations with `kind=pr`.

`NodeAnnotations` — reverse-navigation panel below the NodeInspector. When a node gets selected, shows all annotations whose `members` array contains that node's semantic ID. Click an annotation to select it on the canvas.

`state/pr-stack.ts` — nested state slice under `state.prStack`. Uses `fetchPrStack` / `importPrStack` API wrappers in `api/git.ts` which hit `GET /api/git/pr-stack` and `POST /api/git/pr-stack/import`.

## Known gotchas

- **Do not overwrite `.graphcoder/.gitignore`:** `temporal/cache.ts` merges its required rules into the file, appending only what is missing. It previously rewrote the file wholesale, silently deleting user-added rules on every project open.
- **`loadAllAnnotations` must exclude `*.conversation.json`:** conversation logs live in the same directory as annotations; globbing `*.json` picks them up as malformed annotations.
- **ESM imports:** Use `.js` extensions in all relative TypeScript imports
- **Tailwind v4:** Use `@import 'tailwindcss'` not `@tailwind base/components/utilities`
- **ELK import:** `import ELK from 'elkjs/lib/elk.bundled.js'` (bundled, no web worker)
- **CodeGraph Node 22.5+:** Required for built-in SQLite; currently on Node 26 — fine
- **`skipLibCheck: true`** must stay in tsconfig (CodeGraph types require it)
- **E2E fixtures:** `test-fixtures/**/.codegraph` gitignored — stale/missing index causes nodes to not render. Delete `.codegraph/` from a fixture to force re-index.
- **Production build:** server runs from `dist/index.js`; source changes need `pnpm build` then restart — `tsx watch` not used in production
- **inotify limit:** `cg.watch()` degrades gracefully on ENOSPC — indexing still works, just no auto-sync
- **Three.js back-face culling + Y-down camera:** All `ShaderMaterial` instances in `ThreeRenderer.ts` (container/node rects, arrows, glyphs) must set `side: DoubleSide`. The `OrthographicCamera` uses Y-down convention (`top=0, bottom=h`) to match ELK's coordinate system; this flips the effective winding order of the unit-quad triangles, so Three.js's default `FrontSide` culling silently discards every triangle — draw calls submit correctly (verifiable via `renderer.info.render.triangles`) but zero pixels reach the framebuffer. No GL error, no console warning. Symptom: edges/lines render (unaffected — not triangle-based) but all rect/arrow/glyph fills are invisible.
