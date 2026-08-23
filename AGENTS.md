# GraphCoder — Agent Memory

Bidirectional architectural flow & mutation platform. Digests codebases into deterministic structural graphs, layers Git history as a temporal dimension, and synthesises graph mutations back into code changes.

## Stack

- **Package manager:** pnpm 11 (workspaces)
- **Language:** TypeScript, strict ESM (`"type": "module"` throughout)
- **Server:** Express 5, port 3001
- **Client:** SolidJS + Vite + Tailwind v4, port 3000
- **Layout:** elkjs (ELK Eclipse Layout Kernel)
- **Graph extraction:** `@colbymchenry/codegraph` v1.5.0 (tree-sitter + SQLite, 37 languages)
- **Testing:** Playwright E2E (client), Vitest unit (server/core)
- **Build:** tsdown (server/core), Vite (client)
- **Linting/format:** oxlint + oxfmt (pre-commit hooks)

## Commands

```bash
pnpm dev                                  # start both server + client
pnpm --filter @graphcoder/server dev      # server only (http://localhost:3001)
pnpm --filter @graphcoder/client dev      # client only (http://localhost:3000)
pnpm build                                # build all packages
pnpm -r check                             # type-check all
pnpm test                                 # Playwright E2E (auto-starts server + client)
pnpm test:unit                            # Vitest unit tests (server + core)
```

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

| Phase | Status  | Description                                                     |
| ----- | ------- | --------------------------------------------------------------- |
| 0     | ✅ Done | Read-only graph explorer, ELK layout, Pixi.js canvas, E2E tests |
| 1     | ✅ Done | ArchDiff v2 format, semantic identity layer, diff visualization |
| 2     | Planned | Temporal mapper (Git history → per-commit diffs via worktrees)  |
| 3     | Planned | Prospective state engine (in-memory graph mutations)            |
| 4     | Planned | Code synthesis engine (ArchDiff → file changes → commit loop)   |
| 5     | Planned | Flow generation (LLM-narrated source→sink flows, tethered)      |
| 6     | Planned | AI agent MCP interface                                          |

See `~/.sovereign/membranes/personal/plans/graphcoder.md` for the full design.

## Known gotchas

- **ESM imports:** Use `.js` extensions in all relative TypeScript imports
- **Tailwind v4:** Use `@import 'tailwindcss'` not `@tailwind base/components/utilities`
- **ELK import:** `import ELK from 'elkjs/lib/elk.bundled.js'` (bundled, no web worker)
- **CodeGraph Node 22.5+:** Required for built-in SQLite; currently on Node 26 — fine
- **`skipLibCheck: true`** must stay in tsconfig (CodeGraph types require it)
- **E2E fixtures:** `test-fixtures/**/.codegraph` gitignored — stale/missing index causes nodes to not render. Delete `.codegraph/` from a fixture to force re-index.
- **Production build:** server runs from `dist/index.js`; source changes need `pnpm build` then restart — `tsx watch` not used in production
- **inotify limit:** `cg.watch()` degrades gracefully on ENOSPC — indexing still works, just no auto-sync
