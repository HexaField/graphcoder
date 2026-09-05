import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Walk up from `startDir` until a `.graphcoder/` directory appears.
 * Returns the containing directory, or null if the filesystem root
 * was reached without finding one.
 */
export function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir)
  for (;;) {
    if (existsSync(join(current, '.graphcoder'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
