import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = process.env.FIXTURE_PATH ?? path.resolve(__dirname, '../../../test-fixtures/sample-project')

async function openProject(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('project-path-input').fill(fixturePath)
  await page.getByTestId('open-project-btn').click()
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 30_000 })
  await page.waitForSelector('[data-nodeid]', { timeout: 30_000 })
}

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
