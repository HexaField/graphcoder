/**
 * Git service — branch listing, commit log, and repository status.
 *
 * Uses `simple-git` for all Git operations. All functions accept a
 * `projectRoot` argument so they work on the current project or on any
 * temporary worktree path.
 */
import simpleGit from 'simple-git'

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string // ISO-8601
}

export interface GitStatus {
  isGitRepo: boolean
  currentBranch: string | null
  repoRoot: string | null
}

/** Check whether a directory lives inside a Git repository. */
export async function getGitStatus(projectRoot: string): Promise<GitStatus> {
  try {
    const git = simpleGit(projectRoot)
    const isRepo = await git.checkIsRepo()
    if (!isRepo) return { isGitRepo: false, currentBranch: null, repoRoot: null }
    const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
    const root = await git.revparse(['--show-toplevel'])
    return {
      isGitRepo: true,
      currentBranch: branch.trim(),
      repoRoot: root.trim()
    }
  } catch {
    return { isGitRepo: false, currentBranch: null, repoRoot: null }
  }
}

/** List all branches (local + remote). Returns them sorted alphabetically with current first. */
export async function listBranches(projectRoot: string): Promise<{ branches: string[]; current: string | null }> {
  const git = simpleGit(projectRoot)
  const summary = await git.branch(['-a'])
  // Collect all branch names. Remote branches appear as "remotes/origin/foo" —
  // strip the prefix and deduplicate against local branches.
  const seen = new Set<string>()
  for (const name of summary.all) {
    if (name.includes('/HEAD')) continue // skip remotes/origin/HEAD
    const clean = name.replace(/^remotes\/origin\//, '')
    seen.add(clean)
  }
  const current = summary.current || null
  seen.delete(current ?? '')
  const others = [...seen].sort()
  const branches = current ? [current, ...others] : others
  return { branches, current }
}

/**
 * Return up to `limit` commits on `branch` (newest first).
 * Defaults to HEAD branch, limit 50.
 */
export async function listCommits(projectRoot: string, branch?: string, limit = 50): Promise<CommitInfo[]> {
  const git = simpleGit(projectRoot)
  const ref = branch || 'HEAD'
  const log = await git.log({
    from: undefined,
    to: ref,
    maxCount: limit,
    '--no-walk': undefined
  })
  return log.all.map((c) => ({
    hash: c.hash,
    shortHash: c.hash.slice(0, 8),
    message: c.message,
    author: c.author_name,
    date: c.date
  }))
}

/**
 * Resolve a ref string ('HEAD', a branch name, or a commit hash) to a full
 * 40-character commit hash. Throws if the ref does not exist.
 */
export async function resolveRef(projectRoot: string, ref: string): Promise<string> {
  const git = simpleGit(projectRoot)
  const hash = await git.revparse([ref])
  return hash.trim()
}
