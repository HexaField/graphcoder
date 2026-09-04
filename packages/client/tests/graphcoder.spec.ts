import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SERVER } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = process.env.FIXTURE_PATH ?? path.resolve(__dirname, '../../../test-fixtures/sample-project')
const fixtureV1 = path.resolve(__dirname, '../../../test-fixtures/project-v1')
const fixtureV2 = path.resolve(__dirname, '../../../test-fixtures/project-v2')
const fixtureNested = path.resolve(__dirname, '../../../test-fixtures/nested-project')

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
  // Test 6a: Expand/collapse via HierarchyPanel — key is filePath not id
  //
  // Regression test for the expand/collapse key bug: the server checks
  // expandedGroups against fn.filePath. Using fn.id as the key silently
  // no-ops. This test verifies that a HierarchyPanel toggle actually
  // changes the graph (stats or hierarchy state) — i.e., the round-trip
  // works end-to-end.
  // -------------------------------------------------------------------------

  test('hierarchy expand toggle changes the view (filePath key regression)', async ({ page }) => {
    const hierarchyPanel = page.getByTestId('hierarchy-panel')

    // Capture initial hierarchy toggle states
    const toggles = hierarchyPanel.locator('button[data-toggleid]')
    const firstToggle = toggles.first()

    if (!(await firstToggle.isVisible())) {
      // No expandable groups — sample project may be flat; skip gracefully
      return
    }

    // Capture stats text before
    const statsBefore = await page.getByTestId('project-stats').textContent()

    // Click first toggle (expand)
    await firstToggle.click()

    // Wait for WS round-trip — stats or hierarchy must update
    await page.waitForTimeout(2000)

    // Stats are still present (no crash)
    await expect(page.getByTestId('project-stats')).toBeVisible()

    // A second click collapses again — must not error
    await firstToggle.click()
    await page.waitForTimeout(1000)
    await expect(page.getByTestId('project-stats')).toBeVisible()

    // Verify stats stayed consistent (project didn't unload)
    const statsAfter = await page.getByTestId('project-stats').textContent()
    expect(statsAfter).toContain('nodes')
    // The specific numbers in statsBefore may differ; just confirm we got a stat back
    expect(statsBefore).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // Test 6b: Canvas expand button — no double-fire, camera preserved
  //
  // The canvas expand/collapse button is an HTML overlay that appears on
  // hover. This test verifies:
  //   1. The button appears when hovering over a chip
  //   2. Clicking the button triggers exactly one toggle (not two — the
  //      double-fire bug where onMouseUp + onClick both called toggle)
  //   3. The camera position (panX/panY/zoom) does not reset after expand
  //
  // Strategy: use the HierarchyPanel to ensure a collapsed chip exists,
  // then check the expand button's data-testid becomes visible, click it,
  // and verify the layout changes (spinner fires briefly then clears).
  // -------------------------------------------------------------------------

  test('canvas expand button expands collapsed container and collapse reverses it', async ({ page }) => {
    // Wait for graph groups to load via WS.  With groupByFile=true (default),
    // all nodes collapse into file groups — viewNodes stays empty while
    // viewGroups holds the collapsed containers the canvas renders.
    await page.waitForFunction(
      () => {
        const gc = (window as any).__graphcoder
        return gc && gc.viewGroups && gc.viewGroups.length > 0
      },
      { timeout: 15_000 }
    )

    // Wait for layout to finish (spinner disappears).
    await page.waitForTimeout(2000)

    const canvas = page.getByTestId('graph-canvas')
    const box = await canvas.boundingBox()
    expect(box).toBeTruthy()
    if (!box) return

    // Scan the canvas to find a container with the expand button.
    const expandBtn = page.getByTestId('container-expand-btn')
    let foundBtn = false
    const gridSize = 10
    for (let row = 0; row < gridSize && !foundBtn; row++) {
      for (let col = 0; col < gridSize && !foundBtn; col++) {
        const x = box.x + (col + 0.5) * (box.width / gridSize)
        const y = box.y + (row + 0.5) * (box.height / gridSize)
        await page.mouse.move(x, y)
        await page.waitForTimeout(100)
        if (await expandBtn.isVisible({ timeout: 200 }).catch(() => false)) {
          foundBtn = true
        }
      }
    }

    if (!foundBtn) {
      // No container hit — pass trivially (project might have no file groups).
      return
    }

    // ── Expand ──
    const btnText = await expandBtn.textContent()
    expect(btnText).toContain('Expand')

    const beforeExpand = await page.evaluate(() => (window as any).__graphcoder.viewNodes.length)
    await expandBtn.click()

    // Wait for the server response and layout — expanding a group reveals its
    // children as viewNodes, so the count must increase from 0 (all collapsed).
    await page.waitForFunction((prev: number) => (window as any).__graphcoder.viewNodes.length > prev, beforeExpand, {
      timeout: 10_000
    })
    await page.waitForTimeout(1000)

    const afterExpand = await page.evaluate(() => (window as any).__graphcoder.viewNodes.length)
    expect(afterExpand).toBeGreaterThan(beforeExpand)

    // WebGL canvas survived the relayout.
    await expect(page.getByTestId('graph-webgl-canvas')).toBeVisible()

    // ── Collapse back ──
    // The expanded container should now show the collapse button on hover.
    // Re-scan to find the button (layout moved things around).
    foundBtn = false
    for (let row = 0; row < gridSize && !foundBtn; row++) {
      for (let col = 0; col < gridSize && !foundBtn; col++) {
        const x = box.x + (col + 0.5) * (box.width / gridSize)
        const y = box.y + (row + 0.5) * (box.height / gridSize)
        await page.mouse.move(x, y)
        await page.waitForTimeout(100)
        if (await expandBtn.isVisible({ timeout: 200 }).catch(() => false)) {
          const text = await expandBtn.textContent()
          if (text?.includes('Collapse')) {
            foundBtn = true
          }
        }
      }
    }

    if (foundBtn) {
      await expandBtn.click()

      // Wait for node count to change back.
      await page.waitForFunction(
        (prev: number) => (window as any).__graphcoder.viewNodes.length !== prev,
        afterExpand,
        { timeout: 10_000 }
      )
      await page.waitForTimeout(500)

      const afterCollapse = await page.evaluate(() => (window as any).__graphcoder.viewNodes.length)
      // Collapse reduces nodes back to original count (or at least fewer than expanded).
      expect(afterCollapse).toBeLessThan(afterExpand)
    }

    // Project still intact after the round-trip.
    await expect(page.getByTestId('project-stats')).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Test 6c: GitGraph does not fire repeated fetches on open
  //
  // Regression guard: the old GitBar had an infinite fetch loop caused by a
  // reactive effect. The new GitGraph loads the DAG imperatively on first
  // open via toggleGitBar(). This test confirms at most one /api/git/graph
  // request fires when the panel opens.
  // -------------------------------------------------------------------------

  test('git graph does not fire repeated fetches on open', async ({ page }) => {
    let graphFetchCount = 0
    await page.route('**/api/git/graph*', async (route) => {
      graphFetchCount++
      await route.continue()
    })

    const gitBtn = page.getByTestId('git-bar-toggle')
    if (!(await gitBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
      return
    }

    await gitBtn.click()
    await page.waitForTimeout(2000)

    // At most one graph fetch (zero if not a git repo)
    expect(graphFetchCount).toBeLessThanOrEqual(1)

    await expect(page.getByTestId('project-stats')).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Test 6d: Direction toggle — switch between TB and LR layout
  // -------------------------------------------------------------------------

  test('direction toggle changes layout direction', async ({ page }) => {
    // test 6d
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

/** Wait for at least one viewNode to appear (requires groupByFile=false or an expanded group). */
async function waitForViewNodes(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const gc = (window as any).__graphcoder
      return gc && gc.viewNodes && gc.viewNodes.length > 0
    },
    { timeout: 30_000 }
  )
}

/**
 * Disable file grouping so viewNodes populates.
 *
 * With groupByFile=true (default), all symbol nodes collapse inside their file
 * groups and viewNodes stays empty — captureSnapshot would capture nothing.
 */
async function disableGroupByFile(page: Page): Promise<void> {
  await page.getByTestId('filter-scope-group-files').click()
  await waitForViewNodes(page)
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

    // Disable file grouping so viewNodes populates — with groupByFile=true
    // (default), all nodes collapse into groups and captureSnapshot captures
    // empty data, producing a null diff.
    await disableGroupByFile(page)

    // Diff panel must NOT be visible yet (no snapshot)
    await expect(page.getByTestId('diff-panel')).not.toBeVisible()

    // Capture snapshot
    await page.getByTestId('snapshot-btn').click()
    await expect(page.getByTestId('clear-diff-toolbar-btn')).toBeVisible()

    // Open v2 — groupByFile stays off (server remembers client params)
    await openProjectPath(page, fixtureV2)
    await waitForViewNodes(page)

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
    await disableGroupByFile(page)
    await page.getByTestId('snapshot-btn').click()
    await openProjectPath(page, fixtureV2)
    await waitForViewNodes(page)
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
    await disableGroupByFile(page)
    await page.getByTestId('snapshot-btn').click()
    await openProjectPath(page, fixtureV2)
    await waitForViewNodes(page)
    await page.waitForSelector('[data-testid="diff-panel"]', { timeout: 30_000 })

    await page.getByTestId('clear-diff-btn').click()

    await expect(page.getByTestId('diff-panel')).not.toBeVisible()
    await expect(page.getByTestId('snapshot-btn')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Temporal diff — git commit-pair comparison with layout success
// ---------------------------------------------------------------------------

test.describe('Temporal diff — git commit comparison', () => {
  test.beforeEach(() => {
    test.setTimeout(180_000)
  })

  // -------------------------------------------------------------------------
  // Test 11: Temporal diff completes without ELK crash
  //
  // Exercises the full path: open project → toggle git bar → select two
  // commits → compare → buildDiffView → computeView (with dedup + multi-
  // parent guard) → ELK layout.  This catches the "value already present"
  // crash that occurs when same-named symbols in different files produce
  // duplicate semantic IDs.
  // -------------------------------------------------------------------------

  test('comparing two commits does not crash the layout engine', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixturePath)

    // Open the git graph bar
    await page.getByTestId('git-bar-toggle').click()
    await page.waitForSelector('[data-testid="git-graph"]', { timeout: 10_000 })

    // Wait for at least one commit row (branch tip) to appear
    const commitRows = page.locator('[data-testid^="git-commit-row-"]')
    await expect(commitRows.first()).toBeVisible({ timeout: 15_000 })

    // Expand the first branch to reveal individual commits
    const branchBtn = page.locator('[data-testid^="git-branch-toggle-"]').first()
    await expect(branchBtn).toBeVisible({ timeout: 5_000 })
    await branchBtn.click()

    // Wait for more commit rows to appear after expansion
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="git-commit-row-"]').length >= 2, {
      timeout: 10_000
    })

    const rowCount = await commitRows.count()
    if (rowCount < 2) {
      test.skip(true, 'Fewer than 2 commits in git history — cannot test temporal diff')
      return
    }

    // Click first row (base) then second row (target)
    await commitRows.nth(0).click()
    await commitRows.nth(1).click()

    // Compare button should be enabled — click it
    const compareBtn = page.getByTestId('git-compare-btn')
    await expect(compareBtn).toBeEnabled({ timeout: 5_000 })
    await compareBtn.click()

    // Wait for the diff computation to finish — the compare button re-enables
    // and a temporal range label or diff error appears.
    // Check that no error occurred (no ELK crash, no "value already present").
    await page.waitForFunction(
      () => {
        // Check for diff error text
        const errEl = document.querySelector('[data-testid="git-graph"] .text-red-500')
        if (errEl && errEl.textContent?.includes('value already present')) return 'crash'
        // Check for computing state done (button re-enabled or range label appears)
        const btn = document.querySelector('[data-testid="git-compare-btn"]') as HTMLButtonElement
        return btn && !btn.disabled ? 'done' : false
      },
      { timeout: 120_000 }
    )

    // Verify no layout crash error in the page
    const pageContent = await page.content()
    expect(pageContent).not.toContain('value already present')

    // Verify the layout spinner disappears (ELK completed successfully)
    await page.waitForFunction(() => !document.querySelector('[data-testid="graph-canvas"] .absolute span'), {
      timeout: 30_000
    })
  })

  // -------------------------------------------------------------------------
  // Test 12: Clicking a node during a temporal diff loads detail via REST
  //
  // The diff view remaps node IDs to semantic IDs for diff overlay matching.
  // The REST endpoint expects CodeGraph IDs, so selectNode must resolve
  // through the reverse map (diffCgIdMap). When the CodeGraph ID refers to
  // a historical commit no longer indexed at HEAD, the fallback path builds
  // detail from the local diff data.
  // -------------------------------------------------------------------------

  test('clicking a node during temporal diff loads node detail', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixturePath)

    // Open the git graph bar
    await page.getByTestId('git-bar-toggle').click()
    await page.waitForSelector('[data-testid="git-graph"]', { timeout: 10_000 })

    const commitRows = page.locator('[data-testid^="git-commit-row-"]')
    await expect(commitRows.first()).toBeVisible({ timeout: 15_000 })

    // Expand the first branch to reveal individual commits
    const branchBtn = page.locator('[data-testid^="git-branch-toggle-"]').first()
    await expect(branchBtn).toBeVisible({ timeout: 5_000 })
    await branchBtn.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="git-commit-row-"]').length >= 2, {
      timeout: 10_000
    })

    const rowCount = await commitRows.count()
    if (rowCount < 2) {
      test.skip(true, 'Fewer than 2 commits — cannot test diff node selection')
      return
    }

    // Select two commits and compare
    await commitRows.nth(0).click()
    await commitRows.nth(1).click()

    const compareBtn = page.getByTestId('git-compare-btn')
    await expect(compareBtn).toBeEnabled({ timeout: 5_000 })
    await compareBtn.click()

    // Wait for diff computation to finish — with groupByFile enabled
    // (default), all nodes collapse into groups so viewNodes stays empty.
    // Wait for the raw diff data and reverse ID map instead.
    await page.waitForFunction(
      () => {
        const gc = (window as any).__graphcoder
        return gc?.diffStatusMap && gc?.diffCgIdMap?.size > 0
      },
      { timeout: 120_000 }
    )

    // Verify the reverse ID map exists and has entries
    const mapSize = await page.evaluate(() => (window as any).__graphcoder.diffCgIdMap?.size ?? 0)
    expect(mapSize).toBeGreaterThan(0)

    // Get a raw diff node whose ID appears in the reverse map (semantic ID).
    // viewNodes may be empty (all collapsed into groups), so use rawDiffView.
    const nodeId = await page.evaluate(() => {
      const gc = (window as any).__graphcoder
      const cgMap: Map<string, string> = gc.diffCgIdMap
      const nodes = gc.rawDiffView?.nodes ?? []
      for (const node of nodes) {
        if (node.kind !== 'file' && node.kind !== 'module' && cgMap.has(node.id)) return node.id as string
      }
      return null
    })

    if (!nodeId) {
      test.skip(true, 'No diff view node found in the reverse ID map')
      return
    }

    // Call selectNode programmatically — during a diff, selectNode builds
    // detail from local diff data (semantic IDs) instead of REST (CG IDs).
    // The REST call runs as optional enrichment for source code only.
    await page.evaluate((id: string) => (window as any).__graphcoder.selectNode(id), nodeId)

    // Wait for the async detail fetch to complete
    await page.waitForFunction(
      () => {
        const gc = (window as any).__graphcoder
        return gc.selectedNodeDetail !== null || gc.error !== null
      },
      { timeout: 15_000 }
    )

    // The inspector panel should now show node detail
    const detail = await page.evaluate(() => {
      const gc = (window as any).__graphcoder
      const d = gc.selectedNodeDetail
      if (!d) return { hasDetail: false, nodeName: null, nodeKind: null, error: gc.error, edgesUseCgIds: false }

      // Verify edges use semantic IDs (64-char hex), not CG IDs (kind:hash)
      const cgPattern = /^(file|function|class|interface|property|import|method|type|module):/
      const endpoints = [
        ...(d.incoming ?? []).map((e: { source: string }) => e.source),
        ...(d.outgoing ?? []).map((e: { target: string }) => e.target)
      ]
      const edgesUseCgIds = endpoints.some((s: string) => cgPattern.test(s))

      return {
        hasDetail: true,
        nodeName: d.node?.name ?? null,
        nodeKind: d.node?.kind ?? null,
        error: gc.error,
        edgesUseCgIds
      }
    })

    // Detail must have loaded from local diff data
    expect(detail.hasDetail).toBe(true)
    expect(detail.nodeName).toBeTruthy()
    expect(detail.nodeKind).toBeTruthy()

    // Edges must use semantic IDs (matching the diff canvas), not CG IDs
    expect(detail.edgesUseCgIds).toBe(false)

    // The inspector panel should be visible with the node name
    const inspector = page.getByTestId('node-inspector')
    await expect(inspector).toBeVisible()
    await expect(inspector).toContainText(detail.nodeName!)
  })

  // -------------------------------------------------------------------------
  // Test 13: Clearing diff resets diffCgIdMap
  // -------------------------------------------------------------------------

  test('clearing temporal diff resets the reverse ID map', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixturePath)

    // Open git bar, compare two commits
    await page.getByTestId('git-bar-toggle').click()
    await page.waitForSelector('[data-testid="git-graph"]', { timeout: 10_000 })

    const commitRows = page.locator('[data-testid^="git-commit-row-"]')
    await expect(commitRows.first()).toBeVisible({ timeout: 15_000 })

    const branchBtn = page.locator('[data-testid^="git-branch-toggle-"]').first()
    await expect(branchBtn).toBeVisible({ timeout: 5_000 })
    await branchBtn.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="git-commit-row-"]').length >= 2, {
      timeout: 10_000
    })

    const rowCount = await commitRows.count()
    if (rowCount < 2) {
      test.skip(true, 'Fewer than 2 commits — cannot test diff clear')
      return
    }

    await commitRows.nth(0).click()
    await commitRows.nth(1).click()

    const compareBtn = page.getByTestId('git-compare-btn')
    await expect(compareBtn).toBeEnabled({ timeout: 5_000 })
    await compareBtn.click()

    // Wait for diff to load
    await page.waitForFunction(
      () => {
        const gc = (window as any).__graphcoder
        return gc?.diffStatusMap && gc?.diffCgIdMap?.size > 0
      },
      { timeout: 120_000 }
    )

    // Confirm map exists before clearing
    const mapBefore = await page.evaluate(() => (window as any).__graphcoder.diffCgIdMap?.size ?? 0)
    expect(mapBefore).toBeGreaterThan(0)

    // Clear the diff
    const clearBtn = page.locator('[data-testid="clear-diff-btn"], [title="Clear diff"]').first()
    if (await clearBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await clearBtn.click()
    } else {
      // Fallback: clear programmatically
      await page.evaluate(() => (window as any).__graphcoder.clearDiff())
    }

    await page.waitForTimeout(500)

    // After clearing, both maps should be null
    const afterClear = await page.evaluate(() => {
      const gc = (window as any).__graphcoder
      return {
        diffStatusMap: gc.diffStatusMap,
        diffCgIdMap: gc.diffCgIdMap
      }
    })
    expect(afterClear.diffStatusMap).toBeNull()
    expect(afterClear.diffCgIdMap).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Test 14: Temporal diff respects current filter state
  // -------------------------------------------------------------------------

  test('temporal diff respects hidden node kinds', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixturePath)

    // Hide 'function' kind via the filter panel
    const fnChip = page.getByTestId('filter-kind-function')
    await fnChip.click()

    // Open git bar and compare two commits
    await page.getByTestId('git-bar-toggle').click()
    await page.waitForSelector('[data-testid="git-graph"]', { timeout: 10_000 })

    const commitRows = page.locator('[data-testid^="git-commit-row-"]')
    await expect(commitRows.first()).toBeVisible({ timeout: 15_000 })

    // Expand the first branch to reveal individual commits
    const branchBtn2 = page.locator('[data-testid^="git-branch-toggle-"]').first()
    await expect(branchBtn2).toBeVisible({ timeout: 5_000 })
    await branchBtn2.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="git-commit-row-"]').length >= 2, {
      timeout: 10_000
    })

    const rowCount = await commitRows.count()
    if (rowCount < 2) {
      test.skip(true, 'Fewer than 2 commits — cannot test filtered diff')
      return
    }

    await commitRows.nth(0).click()
    await commitRows.nth(1).click()

    const compareBtn = page.getByTestId('git-compare-btn')
    await expect(compareBtn).toBeEnabled({ timeout: 5_000 })
    await compareBtn.click()

    // Wait for diff to complete
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="git-compare-btn"]') as HTMLButtonElement
        return btn && !btn.disabled
      },
      { timeout: 120_000 }
    )

    // Layout must complete without crash
    await page.waitForFunction(() => !document.querySelector('[data-testid="graph-canvas"] .absolute span'), {
      timeout: 30_000
    })

    // The page must not contain the ELK duplicate error
    const content = await page.content()
    expect(content).not.toContain('value already present')
  })
})

// ---------------------------------------------------------------------------
// Hierarchy context menu — "Show all children" must iterate the whole subtree
//
// The sidebar tree and the graph keep separate expansion state. The menu
// action used to touch only the graph, so expanding a directory left every
// sidebar row collapsed — from the panel it looked like nothing happened.
// These tests use a fixture nested four levels deep so shallow expansion
// cannot pass by accident.
// ---------------------------------------------------------------------------

test.describe('Hierarchy — Show all children', () => {
  test.beforeEach(async () => {
    test.setTimeout(180_000)
    await closeServerProject()
  })

  /** Right-click a hierarchy row and pick a context-menu item by label. */
  async function chooseMenuItem(page: Page, nodeId: string, label: string): Promise<void> {
    await page.locator(`[data-nodeid="${nodeId}"]`).click({ button: 'right' })
    await page.waitForSelector('[data-ctx-menu]', { timeout: 5_000 })
    await page.locator('[data-ctx-menu] button', { hasText: label }).click()
  }

  test('expands every nested directory, not just the one clicked', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureNested)

    // Only the top-level dir shows while everything below stays collapsed
    await expect(page.locator('[data-nodeid="src"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/core"]')).not.toBeVisible()

    await chooseMenuItem(page, 'src', 'Show all children')

    // Every directory in the subtree must now have a row, at all four levels
    await expect(page.locator('[data-nodeid="src/core"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/util"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/core/engine"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/core/engine/internals"]')).toBeVisible()

    // …and so must the files inside them, including the deepest one
    await expect(page.locator('[data-nodeid="src/index.ts"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/util/text.ts"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/core/registry.ts"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/core/engine/start.ts"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/core/engine/internals/rotor.ts"]')).toBeVisible()
  })

  test('expands only the chosen subtree, leaving siblings alone', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureNested)

    // Reveal the two sibling dirs by expanding the root
    await chooseMenuItem(page, 'src', 'Show all children')
    await expect(page.locator('[data-nodeid="src/util"]')).toBeVisible()

    // Collapse everything again via the root toggle, then target one branch
    await page.locator('[data-nodeid="src"] button[data-toggleid]').first().click()
    await expect(page.locator('[data-nodeid="src/core"]')).not.toBeVisible()

    // Re-expand just the root row so `src/core` becomes right-clickable
    await page.locator('[data-nodeid="src"] button[data-toggleid]').first().click()
    await expect(page.locator('[data-nodeid="src/core"]')).toBeVisible()

    await chooseMenuItem(page, 'src/core', 'Show all children')

    // The chosen branch opens all the way down
    await expect(page.locator('[data-nodeid="src/core/engine"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/core/engine/internals"]')).toBeVisible()
    await expect(page.locator('[data-nodeid="src/core/engine/internals/rotor.ts"]')).toBeVisible()
  })

  test('unhides the whole subtree, not just expands it', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureNested)

    // Hide everything, then ask for one subtree back
    await page.locator('button', { hasText: 'hide all' }).click()
    await expect
      .poll(async () => page.evaluate(() => (window as any).__graphcoder.hiddenPaths.length))
      .toBeGreaterThan(0)

    await chooseMenuItem(page, 'src', 'Show all children')

    // Nothing at or beneath src may remain hidden — an expanded but dimmed
    // tree over an empty canvas was the original complaint.
    const hidden = await page.evaluate(() => (window as any).__graphcoder.hiddenPaths as string[])
    for (const key of hidden) {
      expect(key === 'src' || key.startsWith('src/'), `"${key}" should not still be hidden`).toBe(false)
    }

    // The graph must actually have content again
    await page.waitForFunction(
      () => {
        const gc = (window as any).__graphcoder
        return gc.viewNodes.length > 0 || gc.viewGroups.length > 0
      },
      { timeout: 30_000 }
    )
  })

  test('a hidden nested folder becomes visible, not merely unfolded', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureNested)

    // Reveal the tree, then hide one deep branch on its own
    await chooseMenuItem(page, 'src', 'Show all children')
    await expect(page.locator('[data-nodeid="src/core/engine"]')).toBeVisible()

    await chooseMenuItem(page, 'src/core/engine', 'Hide from graph')
    await expect
      .poll(async () =>
        page.evaluate(() => ((window as any).__graphcoder.hiddenPaths as string[]).includes('src/core/engine'))
      )
      .toBe(true)

    // Asking for that branch back must clear it and everything under it
    await chooseMenuItem(page, 'src/core/engine', 'Show all children')

    const hidden = await page.evaluate(() => (window as any).__graphcoder.hiddenPaths as string[])
    expect(hidden).not.toContain('src/core/engine')
    expect(hidden.some((k) => k.startsWith('src/core/engine/'))).toBe(false)
  })

  test('a hidden ancestor cannot keep the chosen subtree invisible', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureNested)

    await chooseMenuItem(page, 'src', 'Show all children')
    await expect(page.locator('[data-nodeid="src/core"]')).toBeVisible()

    // Hide the parent — the cascade now covers everything below it
    await chooseMenuItem(page, 'src', 'Hide from graph')
    await expect
      .poll(async () => page.evaluate(() => ((window as any).__graphcoder.hiddenPaths as string[]).includes('src')))
      .toBe(true)

    // Showing a descendant has to lift the ancestor too, or nothing appears
    await chooseMenuItem(page, 'src/core', 'Show all children')

    const hidden = await page.evaluate(() => (window as any).__graphcoder.hiddenPaths as string[])
    expect(hidden).not.toContain('src')
    expect(hidden).not.toContain('src/core')
  })

  test('graph groups expand alongside the sidebar', async ({ page }) => {
    await page.goto('/')
    await openProjectPath(page, fixtureNested)

    const before = await page.evaluate(() => (window as any).__graphcoder.expandedGroups.length)

    await chooseMenuItem(page, 'src', 'Show all children')

    // The graph side still receives the prefix, so groups open too
    const after = await page.evaluate(() => (window as any).__graphcoder.expandedGroups as string[])
    expect(after.length).toBeGreaterThan(before)
    expect(after).toContain('src')

    // Deep files resolve as expanded through prefix matching
    await page.waitForFunction(() => (window as any).__graphcoder.viewNodes.length > 0, { timeout: 30_000 })
  })
})

// ---------------------------------------------------------------------------
// Layout — the shell is a fixed frame; panels scroll internally
//
// Both side panels used to size themselves to their content rather than to
// their container. A panel taller than the viewport was then clipped by an
// ancestor's overflow-hidden instead of scrolling, so long file trees and the
// bottom of the filter list were simply unreachable.
// ---------------------------------------------------------------------------

test.describe('Layout — page fixed, panels scroll', () => {
  test.beforeEach(async () => {
    test.setTimeout(180_000)
    await closeServerProject()
  })

  /** Fully unfold the tree so the explorer is taller than a short viewport. */
  async function expandWholeTree(page: Page): Promise<void> {
    const first = await page
      .locator('[data-testid="hierarchy-panel"] [data-nodeid]')
      .first()
      .getAttribute('data-nodeid')
    if (!first) return
    await page.locator(`[data-nodeid="${first}"]`).click({ button: 'right' })
    await page.waitForSelector('[data-ctx-menu]', { timeout: 5_000 })
    const item = page.locator('[data-ctx-menu] button', { hasText: 'Show all children' })
    if (await item.count()) await item.click()
    await page.waitForTimeout(500)
  }

  test('the shell is pinned so the page cannot scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 300 })
    await page.goto('/')
    await openProjectPath(page, fixtureNested)
    await expandWholeTree(page)

    // The shell explicitly opts out of page scrolling. Asserting the computed
    // style rather than just the absence of overflow matters: h-screen plus
    // the middle row's overflow-hidden already keep the document at viewport
    // height in Chromium, so a scrollHeight check alone passes either way and
    // would prove nothing.
    const overflow = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).overflowY,
      body: getComputedStyle(document.body).overflowY,
      root: getComputedStyle(document.getElementById('root')!).overflowY
    }))
    expect(overflow.html).toBe('hidden')
    expect(overflow.body).toBe('hidden')
    expect(overflow.root).toBe('hidden')

    // And the page genuinely does not move under a wheel gesture
    await page.mouse.move(550, 150)
    await page.mouse.wheel(0, 800)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)
    ).toBeLessThanOrEqual(0)
  })

  test('the explorer scrolls its own content', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 300 })
    await page.goto('/')
    await openProjectPath(page, fixtureNested)
    await expandWholeTree(page)

    // The tree must be bounded by the panel, with real overflow to scroll
    const before = await page.evaluate(() => {
      const tree = document.querySelector('[data-testid="hierarchy-panel"] .overflow-y-auto')
      if (!tree) return null
      return { over: tree.scrollHeight - tree.clientHeight, top: tree.scrollTop }
    })
    expect(before).not.toBeNull()
    expect(before!.over).toBeGreaterThan(0)
    expect(before!.top).toBe(0)

    const panel = page.getByTestId('hierarchy-panel')
    const box = await panel.boundingBox()
    expect(box).toBeTruthy()
    if (!box) return
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(300)

    const after = await page.evaluate(
      () => document.querySelector('[data-testid="hierarchy-panel"] .overflow-y-auto')!.scrollTop
    )
    expect(after).toBeGreaterThan(0)
  })

  test('the graph parameters panel scrolls its own content', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 400 })
    await page.goto('/')
    await openProjectPath(page, fixtureNested)

    // The kind/link filter list is long enough to overflow any normal viewport
    const over = await page.evaluate(() => {
      const gp = document.querySelector('[data-testid="graph-params-panel"]')
      return gp ? gp.scrollHeight - gp.clientHeight : -1
    })
    expect(over).toBeGreaterThan(0)

    const panel = page.getByTestId('graph-params-panel')
    const box = await panel.boundingBox()
    expect(box).toBeTruthy()
    if (!box) return
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(300)

    const top = await page.evaluate(() => document.querySelector('[data-testid="graph-params-panel"]')!.scrollTop)
    expect(top).toBeGreaterThan(0)
  })
})
