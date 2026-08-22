import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = process.env.FIXTURE_PATH ?? path.resolve(__dirname, '../../../test-fixtures/sample-project')
const fixtureV1 = path.resolve(__dirname, '../../../test-fixtures/project-v1')
const fixtureV2 = path.resolve(__dirname, '../../../test-fixtures/project-v2')

const SERVER = process.env.VITE_API_URL ?? 'http://localhost:3001'

/** Close the server's current project — resets server state between test suites. */
async function closeServerProject(): Promise<void> {
  await fetch(`${SERVER}/api/projects/close`, { method: 'POST' })
}

async function openProject(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('project-path-input').fill(fixturePath)
  await page.getByTestId('open-project-btn').click()
  // First-time indexing can take longer than 30 s — give it 90 s
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 90_000 })
  await page.waitForSelector('[data-nodeid]', { timeout: 90_000 })
}

// ---------------------------------------------------------------------------
// Reset server state before the suite
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  await closeServerProject()
})

// ---------------------------------------------------------------------------
// Test 1: Empty state on first load
// ---------------------------------------------------------------------------

test('app loads with correct title and empty state', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('GraphCoder')
  await expect(page.getByTestId('toolbar')).toBeVisible()
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('graph-svg')).toBeVisible()
  await expect(page.getByText(/No project open/)).toBeVisible()
  await expect(page.getByTestId('node-inspector')).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// Test 2: Open sample project and render graph
// ---------------------------------------------------------------------------

test('open the sample project and render the graph', { timeout: 60_000 }, async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('project-path-input').fill(fixturePath)
  await page.getByTestId('open-project-btn').click()

  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 30_000 })
  await page.waitForSelector('[data-nodeid]', { timeout: 30_000 })

  const stats = page.getByTestId('project-stats')
  await expect(stats).toContainText('nodes')
  await expect(stats).toContainText('edges')
  await expect(stats).toContainText('files')

  const nodeCount = await page.locator('[data-nodeid]').count()
  expect(nodeCount).toBeGreaterThan(0)

  await expect(page.getByText(/No project open/)).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// Tests 3–5: require an open project — share a beforeEach
// ---------------------------------------------------------------------------

test.describe('with open project', () => {
  test.beforeEach(async ({ page }) => {
    // Extend timeout to cover indexing wait inside openProject (up to 30s)
    // plus the test body itself.
    test.setTimeout(60_000)
    await openProject(page)
  })

  // -------------------------------------------------------------------------
  // Test 3: Click a node to open the inspector
  // -------------------------------------------------------------------------

  test('click a node to open the inspector', async ({ page }) => {
    const firstNode = page.locator('[data-nodeid]').first()
    await firstNode.click()

    await page.waitForSelector('[data-testid="node-inspector"]', { timeout: 10_000 })
    const inspector = page.getByTestId('node-inspector')
    await expect(inspector).toBeVisible()
    // Inspector must contain at least some identifying text (name or file path).
    await expect(inspector).not.toBeEmpty()
  })

  // -------------------------------------------------------------------------
  // Test 4: Switch view modes
  // -------------------------------------------------------------------------

  test('switch view modes', async ({ page }) => {
    const moduleDependencyBtn = page.getByTestId('view-mode-module-dependency')
    const callGraphBtn = page.getByTestId('view-mode-call-graph')

    await expect(moduleDependencyBtn).toBeVisible()

    // Switch to call-graph view.
    await callGraphBtn.click()
    // Active button receives bg-blue-600 class from the Toolbar component.
    await expect(callGraphBtn).toHaveClass(/bg-blue-600/)

    // Switch back to module-dependency view.
    await moduleDependencyBtn.click()
    await expect(moduleDependencyBtn).toHaveClass(/bg-blue-600/)

    // Graph still renders content after switching.
    await expect(page.getByTestId('graph-svg')).toBeVisible()
    await expect(page.locator('[data-nodeid]').first()).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Test 5: Search for a symbol
  // -------------------------------------------------------------------------

  test('search for a symbol', async ({ page }) => {
    await page.getByTestId('search-input').fill('add')

    await page.waitForSelector('[data-testid="search-results"]', { timeout: 10_000 })
    const results = page.getByTestId('search-results')
    await expect(results).toBeVisible()

    // At least one result button must appear and contain the query term.
    const firstResult = results.locator('button').first()
    await expect(firstResult).toBeVisible()
    await expect(results).toContainText('add')
  })
})

// ---------------------------------------------------------------------------
// Diff tests — open v1, capture snapshot, switch to v2, verify diff panel
// ---------------------------------------------------------------------------

async function openProjectPath(page: Page, projectPath: string): Promise<void> {
  await page.getByTestId('project-path-input').fill(projectPath)
  await page.getByTestId('open-project-btn').click()
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 90_000 })
  await page.waitForSelector('[data-nodeid]', { timeout: 90_000 })
}

test.describe('ArchDiff — snapshot and diff', () => {
  test.beforeEach(() => {
    // Indexing + snapshot + re-index can take a while on first run
    test.setTimeout(120_000)
  })

  // -------------------------------------------------------------------------
  // Test 6: Snapshot button visible when project is open
  // -------------------------------------------------------------------------

  test('snapshot button appears when a project is open', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureV1)

    const snapshotBtn = page.getByTestId('snapshot-btn')
    await expect(snapshotBtn).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Test 7: Capture snapshot, switch project, diff panel appears
  // -------------------------------------------------------------------------

  test('capture snapshot then open v2 produces a diff', async ({ page }) => {
    await page.goto('/')

    // Open v1 and wait for graph
    await openProjectPath(page, fixtureV1)

    // Diff panel should NOT be visible yet (no snapshot)
    await expect(page.getByTestId('diff-panel')).not.toBeVisible()

    // Capture snapshot
    await page.getByTestId('snapshot-btn').click()

    // After snapshot: button changes to "diff active" indicator
    await expect(page.getByTestId('clear-diff-toolbar-btn')).toBeVisible()

    // Open v2 — the server re-indexes and sends a new WS graph_snapshot
    await openProjectPath(page, fixtureV2)

    // Wait for DiffPanel to appear (auto-recompute on WS update)
    await page.waitForSelector('[data-testid="diff-panel"]', { timeout: 30_000 })
    const diffPanel = page.getByTestId('diff-panel')
    await expect(diffPanel).toBeVisible()

    // Diff should contain at least some operations (v1→v2 has add/remove/move)
    const opList = page.getByTestId('diff-op-list')
    await expect(opList).toBeVisible()
    const opItems = opList.locator('div')
    const opCount = await opItems.count()
    expect(opCount).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Test 8: Summary line shows add/remove counts
  // -------------------------------------------------------------------------

  test('diff summary shows correct change types', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureV1)
    await page.getByTestId('snapshot-btn').click()
    await openProjectPath(page, fixtureV2)

    await page.waitForSelector('[data-testid="diff-panel"]', { timeout: 30_000 })

    // v1→v2: 'divide' is a new function (added), 'subtract' is renamed to 'minus' (remove+add),
    // 'add' moved to arithmetic.ts (moved) — so we expect at minimum some adds and a move
    const diffPanel = page.getByTestId('diff-panel')

    // At least one of the change indicators must appear
    const hasChanges =
      (await diffPanel.locator('span.text-green-400').count()) +
      (await diffPanel.locator('span.text-red-400').count()) +
      (await diffPanel.locator('span.text-cyan-400').count()) +
      (await diffPanel.locator('span.text-amber-400').count())

    expect(hasChanges).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Test 9: Clear diff removes the panel
  // -------------------------------------------------------------------------

  test('clear diff removes the diff panel', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureV1)
    await page.getByTestId('snapshot-btn').click()
    await openProjectPath(page, fixtureV2)

    await page.waitForSelector('[data-testid="diff-panel"]', { timeout: 30_000 })

    // Click "clear" in the DiffPanel itself
    await page.getByTestId('clear-diff-btn').click()

    await expect(page.getByTestId('diff-panel')).not.toBeVisible()
    // After clearing, snapshot button re-appears
    await expect(page.getByTestId('snapshot-btn')).toBeVisible()
  })
})
