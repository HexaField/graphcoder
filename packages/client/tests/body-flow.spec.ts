import { test, expect, type Locator, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SERVER } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.resolve(__dirname, '../../../test-fixtures/body-flow-project')

async function openProject(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('project-path-input').fill(fixture)
  await page.getByTestId('open-project-btn').click()
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 90_000 })
  await page.waitForSelector('[data-testid="hierarchy-panel"] [data-nodeid]', { timeout: 30_000 })
}

/** Pick a symbol from search by exact name and file. */
async function selectSymbol(page: Page, name: string, file: string): Promise<void> {
  await page.getByTestId('search-input').fill(name)
  await page
    .getByTestId('search-results')
    .getByRole('button')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ hasText: file })
    .first()
    .click()
}

/** Select a symbol, expand its body flow, and return the card. */
async function expandBodyFlow(page: Page, name: string, file: string): Promise<Locator> {
  await selectSymbol(page, name, file)
  await page.getByTestId('body-flow-toggle').click()
  const card = page.getByTestId('body-flow-card').filter({ hasText: name })
  await expect(card).toBeVisible()
  return card
}

/** Visible label of each CF node — its <text> children, not the <title> tooltip. */
const labels = (nodes: Locator) =>
  nodes.evaluateAll((els) =>
    els.map((el) => [...el.querySelectorAll(':scope > text')].map((t) => t.textContent?.trim() ?? '').join(', '))
  )

test.beforeAll(async () => {
  await fetch(`${SERVER}/api/projects/close`, { method: 'POST' })
})

test.describe('Body flow', () => {
  test.describe.configure({ timeout: 60_000 })

  test('expands a TypeScript function into a flowchart with linked calls', async ({ page }) => {
    await openProject(page)
    const card = await expandBodyFlow(page, 'handleLogin', 'login.ts')

    await expect(card).toContainText('function handleLogin(user: string, password: string): string')
    const kinds = await card.getByTestId('cf-node').evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')))
    expect(kinds).toEqual(expect.arrayContaining(['entry', 'branch', 'call', 'guard', 'exit']))
    expect(await labels(card.locator('[data-testid="cf-node"][data-target]'))).toEqual(
      expect.arrayContaining(['validate', 'login'])
    )
    // Outside flow view there is no path slice
    await expect(card.locator('[data-on-path]')).toHaveCount(0)
  })

  test('clicking a linked call selects its target', async ({ page }) => {
    await openProject(page)
    const card = await expandBodyFlow(page, 'handleLogin', 'login.ts')

    await card.locator('[data-testid="cf-node"][data-target]').filter({ hasText: 'validate' }).click()
    await expect(page.getByTestId('node-inspector').locator('.font-semibold').first()).toHaveText('validate')
  })

  test('flow view highlights the path to the next traced function', async ({ page }) => {
    await openProject(page)
    await page.locator('[data-testid="view-mode-flow"]:visible').click()
    const picker = page.getByTestId('entry-point-picker')
    await picker.getByRole('button').filter({ hasText: 'handleLogin' }).first().click()
    await expect(page.getByTestId('flow-panel')).toBeVisible()

    const card = await expandBodyFlow(page, 'handleLogin', 'login.ts')
    const path = card.getByTestId('body-flow-path')
    await expect(path).toContainText('validate')
    await expect(path).toContainText('login')

    const onPath = await labels(card.locator('[data-testid="cf-node"][data-on-path="true"]'))
    expect(onPath.sort()).toEqual(['handleLogin', 'if (!user)', 'if (ok)', 'login', 'validate'])
    const offPath = await labels(card.locator('[data-testid="cf-node"][data-on-path="false"]'))
    expect(offPath).toEqual(expect.arrayContaining(["throw new Error('missing user')", 'JSON.stringify', 'exit']))
    await expect(card.locator('[data-testid="cf-edge"][data-on-path="true"]')).toHaveCount(4)
  })

  for (const { language, name, file, kinds, target } of [
    {
      language: 'Python',
      name: 'process',
      file: 'pipeline.py',
      kinds: ['loop', 'try', 'catch', 'guard'],
      target: 'load'
    },
    { language: 'Go', name: 'Run', file: 'worker.go', kinds: ['loop', 'branch', 'guard'], target: 'execute' },
    { language: 'Rust', name: 'run', file: 'engine.rs', kinds: ['loop', 'branch', 'guard'], target: 'check' }
  ]) {
    test(`expands a ${language} function`, async ({ page }) => {
      await openProject(page)
      const card = await expandBodyFlow(page, name, file)
      const found = await card
        .getByTestId('cf-node')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')))
      expect(found).toEqual(expect.arrayContaining(['entry', ...kinds, 'exit']))
      expect(await labels(card.locator('[data-testid="cf-node"][data-target]'))).toContain(target)
    })
  }

  test('reports why a function cannot expand', async ({ page }) => {
    await openProject(page)
    // Go `func checksum(data []byte) uint32` is implemented in assembly: no body to walk
    await selectSymbol(page, 'checksum', 'worker.go')
    await page.getByTestId('body-flow-toggle').click()
    await expect(page.getByTestId('body-flow-error')).toHaveText('Could not extract body flow for checksum')
    await expect(page.getByTestId('body-flow-card')).toHaveCount(0)
  })
})
