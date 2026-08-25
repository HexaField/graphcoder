/**
 * Temporal snapshot cache — SQLite-backed persistence for per-commit graph
 * snapshots and commit-pair diffs.
 *
 * Cache file: `{projectRoot}/.graphcoder/temporal.sqlite`
 *
 * Tables:
 *   snapshots  — serialized { nodes, edges } per commit hash
 *   diffs      — serialized ArchDiff per (base_hash, target_hash) pair
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArchDiff } from '@graphcoder/core'
import type { GraphSnapshot } from '@graphcoder/core'

// Bump when the snapshot format changes (e.g. new edge types) to
// invalidate cached entries that lack the new data.
const SNAPSHOT_VERSION = 2

// One DB instance per project root — keeps connections from multiplying.
const dbCache = new Map<string, Database.Database>()

function graphcoderDir(projectRoot: string): string {
  return join(projectRoot, '.graphcoder')
}

function dbPath(projectRoot: string): string {
  return join(graphcoderDir(projectRoot), 'temporal.sqlite')
}

function getDb(projectRoot: string): Database.Database {
  const existing = dbCache.get(projectRoot)
  if (existing) return existing

  const dir = graphcoderDir(projectRoot)
  mkdirSync(dir, { recursive: true })

  // Ensure a .gitignore exists — same pattern as .codegraph/.gitignore.
  const gi = join(dir, '.gitignore')
  if (!existsSync(gi)) {
    writeFileSync(
      gi,
      [
        '# GraphCoder data files — local to each machine, not for committing.',
        '# Ignore everything in .graphcoder/ except this file itself.',
        '*',
        '!.gitignore',
        ''
      ].join('\n')
    )
  }

  const db = new Database(dbPath(projectRoot))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      commit_hash TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      indexed_at   INTEGER NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS diffs (
      base_hash   TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      diff_json   TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      PRIMARY KEY (base_hash, target_hash)
    );
  `)

  // Ensure the version column exists on DBs created before v2.
  try {
    db.exec('ALTER TABLE snapshots ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
  } catch {
    // Column already exists — expected after the first upgrade.
  }

  dbCache.set(projectRoot, db)
  return db
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

export function getCachedSnapshot(projectRoot: string, commitHash: string): GraphSnapshot | null {
  const db = getDb(projectRoot)
  const row = db
    .prepare('SELECT snapshot_json FROM snapshots WHERE commit_hash = ? AND version = ?')
    .get(commitHash, SNAPSHOT_VERSION) as { snapshot_json: string } | undefined
  if (!row) return null
  return JSON.parse(row.snapshot_json) as GraphSnapshot
}

export function setCachedSnapshot(projectRoot: string, commitHash: string, snapshot: GraphSnapshot): void {
  const db = getDb(projectRoot)
  db.prepare(`
    INSERT OR REPLACE INTO snapshots (commit_hash, snapshot_json, indexed_at, version)
    VALUES (?, ?, ?, ?)
  `).run(commitHash, JSON.stringify(snapshot), Date.now(), SNAPSHOT_VERSION)
}

// ── Diffs ─────────────────────────────────────────────────────────────────────

export function getCachedDiff(projectRoot: string, baseHash: string, targetHash: string): ArchDiff | null {
  const db = getDb(projectRoot)
  const row = db
    .prepare('SELECT diff_json FROM diffs WHERE base_hash = ? AND target_hash = ?')
    .get(baseHash, targetHash) as { diff_json: string } | undefined
  if (!row) return null
  return JSON.parse(row.diff_json) as ArchDiff
}

export function setCachedDiff(projectRoot: string, baseHash: string, targetHash: string, diff: ArchDiff): void {
  const db = getDb(projectRoot)
  db.prepare(`
    INSERT OR REPLACE INTO diffs (base_hash, target_hash, diff_json, computed_at)
    VALUES (?, ?, ?, ?)
  `).run(baseHash, targetHash, JSON.stringify(diff), Date.now())
}

/** Close a database connection when the project changes. */
export function closeDb(projectRoot: string): void {
  const db = dbCache.get(projectRoot)
  if (db) {
    db.close()
    dbCache.delete(projectRoot)
  }
}
