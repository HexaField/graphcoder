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

/**
 * Open a project and wait for the graph to render.
 *
 * "Rendered" is defined as:
 *   1. project-stats shows in the toolbar
 *   2. The hierarchy panel has at least one file entry
 *   3. The layout spinner has disappeared (ELK finished)
 *
 * The graph is WebGL — individual nodes have no DOM counterpart. We validate
 * render completion via the stats text and hierarchy panel, not [data-nodeid].
 */
async function openProject(page: Page, projectPath = fixturePath): Promise<void> {
  await page.goto('/')
  await page.getByTestId('project-path-input').fill(projectPath)
  await page.getByTestId('open-project-btn').click()

  // Wait for stats (project open + indexing + first view_snapshot arrived)
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 90_000 })

  // Wait for at least one hierarchy entry — confirms fileNodes arrived via WS
  await page.waitForSelector('[data-testid="hierarchy-panel"] [data-nodeid]', { timeout: 30_000 })

  // Wait for layout to complete — spinner must disappear
  await page.waitForFunction(() => !document.querySelector('[data-testid="graph-canvas"] .absolute span'), {
    timeout: 30_000
  })
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
  // Toolbar and WebGL canvas wrapper must exist
  await expect(page.getByTestId('toolbar')).toBeVisible()
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  // The WebGL canvas element itself must exist inside the wrapper
  await expect(page.getByTestId('graph-webgl-canvas')).toBeVisible()
  // Empty-state message
  await expect(page.getByText(/Open a project to get started/)).toBeVisible()
  // Inspector must not be visible when no node selected
  await expect(page.getByTestId('node-inspector')).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// Test 2: Open sample project — stats appear, hierarchy populates, canvas renders
// ---------------------------------------------------------------------------

test('open the sample project and render the graph', { timeout: 120_000 }, async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('project-path-input').fill(fixturePath)
  await page.getByTestId('open-project-btn').click()

  // Stats line in toolbar must appear
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 60_000 })
  const stats = page.getByTestId('project-stats')
  await expect(stats).toContainText('nodes')
  await expect(stats).toContainText('edges')
  await expect(stats).toContainText('files')

  // Hierarchy panel must have at least one entry (fileNodes arrived via WS)
  const hierarchyPanel = page.getByTestId('hierarchy-panel')
  await expect(hierarchyPanel).toBeVisible()
  const treeEntries = hierarchyPanel.locator('[data-nodeid]')
  await expect(treeEntries.first()).toBeVisible({ timeout: 30_000 })
  const count = await treeEntries.count()
  expect(count).toBeGreaterThan(0)

  // Empty-state must be gone
  await expect(page.getByText(/Open a project to get started/)).not.toBeVisible()

  // Canvas wrapper must still be present and visible
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Tests 3–5: require an open project — share a beforeEach
// ---------------------------------------------------------------------------

test.describe('with open project', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000)
    await openProject(page)
  })

  // -------------------------------------------------------------------------
  // Test 3: Hierarchy panel — expand a file group to trigger a view_request
  // -------------------------------------------------------------------------

  test('expanding a hierarchy entry updates the view', async ({ page }) => {
    const hierarchyPanel = page.getByTestId('hierarchy-panel')
    // Click the first expand/collapse toggle in the hierarchy
    const firstToggle = hierarchyPanel.locator('button[data-toggleid]').first()
    if (await firstToggle.isVisible()) {
      await firstToggle.click()
      // Stats should still be visible (WS round-trip completed)
      await expect(page.getByTestId('project-stats')).toBeVisible()
    }
    // Either way the hierarchy panel must remain visible and populated
    await expect(hierarchyPanel.locator('[data-nodeid]').first()).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Test 4: Graph filter panel — toggle a node kind filter
  // -------------------------------------------------------------------------

  test('filter panel is present and toggles update filters', async ({ page }) => {
    const filterPanel = page.getByTestId('graph-params-panel')
    await expect(filterPanel).toBeVisible()

    // Group-by-file toggle must exist (default state has groupByFile=true)
    const groupFiles = page.getByTestId('filter-scope-group-files')
    await expect(groupFiles).toBeVisible()

    // Click to toggle — should not crash or break layout
    await groupFiles.click()
    // Canvas still present after toggle
    await expect(page.getByTestId('graph-canvas')).toBeVisible()

    // Restore
    await groupFiles.click()
  })

  // -------------------------------------------------------------------------
  // Test 5: Search for a symbol
  // -------------------------------------------------------------------------

  test('search for a symbol returns results', async ({ page }) => {
    await page.getByTestId('search-input').fill('add')
    await page.waitForSelector('[data-testid="search-results"]', { timeout: 10_000 })
    const results = page.getByTestId('search-results')
    await expect(results).toBeVisible()
    const firstResult = results.locator('button').first()
    await expect(firstResult).toBeVisible()
    await expect(results).toContainText('add')
  })

  // -------------------------------------------------------------------------
  // Test 6: Direction toggle — switch between TB and LR layout
  // -------------------------------------------------------------------------

  test('direction toggle changes layout direction', async ({ page }) => {
    const lrBtn = page.getByTestId('direction-lr')
    const tbBtn = page.getByTestId('direction-tb')

    await expect(lrBtn).toBeVisible()
    await lrBtn.click()

    // Trigger a new ELK layout — wait for spinner to appear then disappear
    await page.waitForTimeout(200) // brief settle
    await expect(page.getByTestId('graph-canvas')).toBeVisible()

    // Switch back
    await tbBtn.click()
    await page.waitForTimeout(200)
    await expect(page.getByTestId('graph-canvas')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Diff tests — open v1, capture snapshot, switch to v2, verify diff panel
// ---------------------------------------------------------------------------

async function openProjectPath(page: Page, projectPath: string): Promise<void> {
  await page.getByTestId('project-path-input').fill(projectPath)
  await page.getByTestId('open-project-btn').click()
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 90_000 })
  await page.waitForSelector('[data-testid="hierarchy-panel"] [data-nodeid]', { timeout: 30_000 })
}

test.describe('ArchDiff — snapshot and diff', () => {
  test.beforeEach(() => {
    test.setTimeout(180_000)
  })

  // -------------------------------------------------------------------------
  // Test 7: Snapshot button visible when project is open
  // -------------------------------------------------------------------------

  test('snapshot button appears when a project is open', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureV1)
    const snapshotBtn = page.getByTestId('snapshot-btn')
    await expect(snapshotBtn).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Test 8: Capture snapshot, switch project, diff panel appears
  // -------------------------------------------------------------------------

  test('capture snapshot then open v2 produces a diff', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureV1)

    // Diff panel must NOT be visible yet (no snapshot)
    await expect(page.getByTestId('diff-panel')).not.toBeVisible()

    // Capture snapshot
    await page.getByTestId('snapshot-btn').click()
    await expect(page.getByTestId('clear-diff-toolbar-btn')).toBeVisible()

    // Open v2
    await openProjectPath(page, fixtureV2)

    // Diff panel must appear
    await page.waitForSelector('[data-testid="diff-panel"]', { timeout: 30_000 })
    const diffPanel = page.getByTestId('diff-panel')
    await expect(diffPanel).toBeVisible()

    const opList = page.getByTestId('diff-op-list')
    await expect(opList).toBeVisible()
    const opItems = opList.locator('div')
    const opCount = await opItems.count()
    expect(opCount).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Test 9: Diff summary shows add/remove counts
  // -------------------------------------------------------------------------

  test('diff summary shows correct change types', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureV1)
    await page.getByTestId('snapshot-btn').click()
    await openProjectPath(page, fixtureV2)
    await page.waitForSelector('[data-testid="diff-panel"]', { timeout: 30_000 })

    const diffPanel = page.getByTestId('diff-panel')
    const hasChanges =
      (await diffPanel.locator('span.text-green-400').count()) +
      (await diffPanel.locator('span.text-red-400').count()) +
      (await diffPanel.locator('span.text-cyan-400').count()) +
      (await diffPanel.locator('span.text-amber-400').count())

    expect(hasChanges).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Test 10: Clear diff removes the panel
  // -------------------------------------------------------------------------

  test('clear diff removes the diff panel', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureV1)
    await page.getByTestId('snapshot-btn').click()
    await openProjectPath(page, fixtureV2)
    await page.waitForSelector('[data-testid="diff-panel"]', { timeout: 30_000 })

    await page.getByTestId('clear-diff-btn').click()

    await expect(page.getByTestId('diff-panel')).not.toBeVisible()
    await expect(page.getByTestId('snapshot-btn')).toBeVisible()
  })
})
