# GraphCoder

Bidirectional architectural flow & mutation platform. Ingests any codebase into a deterministic structural graph, overlays Git history as a temporal dimension, and synthesises graph mutations back into real code changes.

Think of it as a two-way mirror between your code and a live, queryable architecture model — not a static diagram, but an active workspace where you can explore, diff, and eventually edit the structure directly.

## What it does today

- **Graph explorer** — full-project call graph, file grouping, contract surface grouping (REST / WebSocket / GraphQL / Services / UI), node/edge kind filtering, symbol search, focus mode
- **Diff overlay** — capture a structural snapshot then keep coding; the canvas shows a live ring-diff of adds, removes, moves, and modifications against the baseline
- **HTTP bridge** — synthetic `calls` edges across the HTTP boundary: `fetch()` calls in client code link directly to their matching Express route handlers, bridging the gap static analysis can't cross

## Architecture

```
packages/
  core/    — shared types: GraphSnapshot, ArchDiff v2, semantic identity
  server/  — Express 5 API + CodeGraph + WebSocket + HTTP bridge analyser
  client/  — SolidJS + ELK layout + Pixi.js canvas
```

Server at `:3001`, client at `:3000`. Start both with `pnpm dev`.

## Phase progress

| Phase | Status  | What                                                           |
| ----- | ------- | -------------------------------------------------------------- |
| 0     | ✅ Done | Read-only explorer — graph, layout, canvas, E2E test suite     |
| 1     | ✅ Done | ArchDiff v2 — semantic identity, diff computation, overlay UI  |
| 2     | 🔜 Next | Temporal mapper — Git history → per-commit ArchDiffs           |
| 3     | Planned | Prospective state — in-memory graph mutations, preview changes |
| 4     | Planned | Synthesis engine — ArchDiff → file edits → commit loop         |
| 5     | Planned | Flow generation — LLM-narrated source→sink flows, tethered     |
| 6     | Planned | MCP interface — AI agent access to the full mutation platform  |

## Quick start

```bash
pnpm install
pnpm dev
# open http://localhost:3000
# enter a project path → graph loads
```

Requires Node 22.5+ (built-in SQLite for CodeGraph).
