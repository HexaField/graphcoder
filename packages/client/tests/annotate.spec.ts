/**
 * Drawing, kinds, and IDE-surface tests.
 *
 * The premise of the redesign: the user never picks an annotation kind from
 * a fixed menu. They draw, and the gesture picks the shape; they type, and
 * the name becomes a kind. These tests exercise that path end to end.
 */
import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = process.env.FIXTURE_PATH ?? path.resolve(__dirname, '../../../test-fixtures/sample-project')

const SERVER = process.env.VITE_API_URL ?? 'http://localhost:3001'

async function closeServerProject(): Promise<void> {
  await fetch(`${SERVER}/api/projects/close`, { method: 'POST' })
}

async function deleteAllAnnotations(): Promise<void> {
  const res = await fetch(`${SERVER}/api/annotations`)
  if (!res.ok) return
  const data = (await res.json()) as { annotations: Array<{ id: string }> }
  for (const ann of data.annotations) {
    await fetch(`${SERVER}/api/annotations/${ann.id}`, { method: 'DELETE' })
  }
}

/** Clear the kind registry — it persists on disk independently of annotations. */
async function deleteAllKinds(): Promise<void> {
  const res = await fetch(`${SERVER}/api/annotation-kinds`)
  if (!res.ok) return
  const { kinds } = (await res.json()) as { kinds: Array<{ name: string }> }
  for (const k of kinds) {
    await fetch(`${SERVER}/api/annotation-kinds/${encodeURIComponent(k.name)}`, { method: 'DELETE' })
  }
}

/** Wipe all annotation state — annotations first, then the kinds they registered. */
async function resetAnnotationState(): Promise<void> {
  await deleteAllAnnotations()
  await deleteAllKinds()
}

async function openProject(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('project-path-input').fill(fixturePath)
  await page.getByTestId('open-project-btn').click()
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 90_000 })
  await page.waitForSelector('[data-testid="hierarchy-panel"] [data-nodeid]', { timeout: 30_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="graph-canvas"] .absolute span'), {
    timeout: 30_000
  })
}

/** Fetch all annotations straight from the API. */
async function getAnnotations(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${SERVER}/api/annotations`)
  if (!res.ok) return []
  const data = (await res.json()) as { annotations: Array<Record<string, unknown>> }
  return data.annotations
}

/** Poll until an annotation matching the predicate appears. */
async function waitForAnnotation(
  match: (a: Record<string, unknown>) => boolean,
  timeoutMs = 10_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = (await getAnnotations()).find(match)
    if (found) return found
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`No matching annotation within ${timeoutMs}ms`)
}

test.beforeAll(async () => {
  await closeServerProject()
})

// ── Drawing gestures ────────────────────────────────────────────────────────

test.describe('Drawing gestures decide the shape', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000)
    await resetAnnotationState()
    await openProject(page)
  })

  test.afterEach(async () => {
    await resetAnnotationState()
  })

  test('pressing A enters annotate mode and Escape leaves it', async ({ page }) => {
    await expect(page.getByTestId('annotate-hint')).not.toBeVisible()

    await page.keyboard.press('a')
    await expect(page.getByTestId('annotate-hint')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('annotate-hint')).not.toBeVisible()
  })

  test('dragging on empty canvas produces a region', async ({ page }) => {
    await page.keyboard.press('a')
    await expect(page.getByTestId('annotate-hint')).toBeVisible()

    const canvas = page.getByTestId('graph-canvas')
    const box = await canvas.boundingBox()
    expect(box).toBeTruthy()
    if (!box) return

    // Lasso a square in an empty corner of the canvas
    const x0 = box.x + box.width * 0.08
    const y0 = box.y + box.height * 0.08
    const size = Math.min(box.width, box.height) * 0.2

    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x0 + size, y0, { steps: 8 })
    await page.mouse.move(x0 + size, y0 + size, { steps: 8 })
    await page.mouse.move(x0, y0 + size, { steps: 8 })
    await page.mouse.move(x0, y0, { steps: 8 })
    await page.mouse.up()

    // The inline kind input appears at the shape — no modal
    const kindInput = page.getByTestId('kind-input')
    await expect(kindInput).toBeVisible()
    await expect(kindInput).toContainText('region')

    // Name a brand-new kind
    await page.getByTestId('kind-input-kind').fill('subsystem')
    await expect(page.getByTestId('kind-input-new')).toBeVisible()
    await page.keyboard.press('Enter')

    const ann = await waitForAnnotation((a) => a.kind === 'subsystem')
    expect(ann.shape).toBe('region')
    // The drawn outline persisted
    const geometry = ann.geometry as { points: number[][] }
    expect(geometry.points.length).toBeGreaterThanOrEqual(3)
  })

  test('clicking empty canvas produces a point', async ({ page }) => {
    await page.keyboard.press('a')

    const canvas = page.getByTestId('graph-canvas')
    const box = await canvas.boundingBox()
    expect(box).toBeTruthy()
    if (!box) return

    // A click with no travel — should read as a pin, not a lasso
    await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.75)
    await page.mouse.down()
    await page.mouse.up()

    await expect(page.getByTestId('kind-input')).toBeVisible()
    await expect(page.getByTestId('kind-input')).toContainText('point')

    await page.getByTestId('kind-input-kind').fill('todo')
    await page.keyboard.press('Enter')

    const ann = await waitForAnnotation((a) => a.kind === 'todo')
    expect(ann.shape).toBe('point')
  })

  test('Escape cancels a drawn shape before it is named', async ({ page }) => {
    await page.keyboard.press('a')

    const canvas = page.getByTestId('graph-canvas')
    const box = await canvas.boundingBox()
    expect(box).toBeTruthy()
    if (!box) return

    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.6)
    await page.mouse.down()
    await page.mouse.up()

    await expect(page.getByTestId('kind-input')).toBeVisible()

    // Escape from inside the kind input discards the shape
    await page.getByTestId('kind-input-kind').press('Escape')
    await expect(page.getByTestId('kind-input')).not.toBeVisible()

    expect(await getAnnotations()).toHaveLength(0)
  })

  test('a label distinct from the kind is preserved', async ({ page }) => {
    await page.keyboard.press('a')

    const canvas = page.getByTestId('graph-canvas')
    const box = await canvas.boundingBox()
    if (!box) return

    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.8)
    await page.mouse.down()
    await page.mouse.up()

    await page.getByTestId('kind-input-kind').fill('hot path')
    await page.getByTestId('kind-input-label').fill('Login request')
    await page.keyboard.press('Enter')

    const ann = await waitForAnnotation((a) => a.kind === 'hot path')
    expect(ann.label).toBe('Login request')
  })
})

// ── Kind registry ───────────────────────────────────────────────────────────

test.describe('User-defined kinds', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000)
    await resetAnnotationState()
    await openProject(page)
  })

  test.afterEach(async () => {
    await resetAnnotationState()
  })

  test('creating an annotation registers its kind with a colour', async () => {
    const createRes = await fetch(`${SERVER}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shape: 'region',
        kind: 'data layer',
        label: 'Persistence',
        members: []
      })
    })
    expect(createRes.status).toBe(201)

    const kindsRes = await fetch(`${SERVER}/api/annotation-kinds`)
    const { kinds } = (await kindsRes.json()) as { kinds: Array<{ name: string; color: string }> }

    const registered = kinds.find((k) => k.name === 'data layer')
    expect(registered).toBeTruthy()
    expect(registered!.color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test('any kind name is accepted — there is no fixed vocabulary', async () => {
    const names = ['module', 'tech debt', 'π-shaped concern', 'Auth Flow 2.0', 'ünïcödé']

    for (const kind of names) {
      const res = await fetch(`${SERVER}/api/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shape: 'point', kind, label: `Test ${kind}`, members: [] })
      })
      expect(res.status, `kind "${kind}" should be accepted`).toBe(201)
      const created = (await res.json()) as { kind: string }
      expect(created.kind).toBe(kind)
    }
  })

  test('kinds match case-insensitively but keep the case first typed', async () => {
    await fetch(`${SERVER}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shape: 'point', kind: 'Module', label: 'First', members: [] })
    })
    await fetch(`${SERVER}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shape: 'point', kind: 'module', label: 'Second', members: [] })
    })

    const kindsRes = await fetch(`${SERVER}/api/annotation-kinds`)
    const { kinds } = (await kindsRes.json()) as { kinds: Array<{ name: string }> }

    // One registry entry, keeping the original capitalisation
    const moduleKinds = kinds.filter((k) => k.name.toLowerCase() === 'module')
    expect(moduleKinds).toHaveLength(1)
    expect(moduleKinds[0]!.name).toBe('Module')
  })

  test('renaming a kind rewrites every annotation using it', async () => {
    for (const label of ['One', 'Two', 'Three']) {
      await fetch(`${SERVER}/api/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shape: 'region', kind: 'oldname', label, members: [] })
      })
    }

    const patchRes = await fetch(`${SERVER}/api/annotation-kinds/oldname`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'newname' })
    })
    expect(patchRes.status).toBe(200)

    const annotations = await getAnnotations()
    const renamed = annotations.filter((a) => a.kind === 'newname')
    expect(renamed).toHaveLength(3)
    expect(annotations.filter((a) => a.kind === 'oldname')).toHaveLength(0)
  })

  test('recolouring a kind persists', async () => {
    await fetch(`${SERVER}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shape: 'point', kind: 'recolor-me', label: 'X', members: [] })
    })

    const patchRes = await fetch(`${SERVER}/api/annotation-kinds/recolor-me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#123456' })
    })
    expect(patchRes.status).toBe(200)

    const kindsRes = await fetch(`${SERVER}/api/annotation-kinds`)
    const { kinds } = (await kindsRes.json()) as { kinds: Array<{ name: string; color: string }> }
    expect(kinds.find((k) => k.name === 'recolor-me')!.color).toBe('#123456')
  })

  test('an invalid colour is rejected', async () => {
    await fetch(`${SERVER}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shape: 'point', kind: 'colour-test', label: 'X', members: [] })
    })

    const res = await fetch(`${SERVER}/api/annotation-kinds/colour-test`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: 'not-a-colour' })
    })
    expect(res.status).toBe(400)
  })

  test('the outline groups annotations under their kind', async ({ page }) => {
    for (const [kind, label] of [
      ['alpha', 'A1'],
      ['alpha', 'A2'],
      ['beta', 'B1']
    ]) {
      await fetch(`${SERVER}/api/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shape: 'region', kind, label, members: [] })
      })
    }

    // Shift+A reveals the annotation panel
    await page.keyboard.press('Shift+A')
    await expect(page.getByTestId('annotation-panel')).toBeVisible()

    await expect(page.getByTestId('kind-group-alpha')).toBeVisible()
    await expect(page.getByTestId('kind-group-beta')).toBeVisible()
    await expect(page.getByTestId('kind-group-alpha')).toContainText('A1')
    await expect(page.getByTestId('kind-group-alpha')).toContainText('A2')
  })

  test('the inline kind input suggests kinds already in use', async ({ page }) => {
    await fetch(`${SERVER}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shape: 'region', kind: 'existing-kind', label: 'Seed', members: [] })
    })

    // Reload so the client picks up the registry
    await openProject(page)
    await page.keyboard.press('a')

    const box = await page.getByTestId('graph-canvas').boundingBox()
    if (!box) return
    await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.7)
    await page.mouse.down()
    await page.mouse.up()

    await expect(page.getByTestId('kind-input')).toBeVisible()
    await page.getByTestId('kind-input-kind').fill('exist')

    await expect(page.getByTestId('kind-suggestion-existing-kind')).toBeVisible()
  })
})

// ── Command palette ─────────────────────────────────────────────────────────

test.describe('Command palette', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000)
    await resetAnnotationState()
    await openProject(page)
  })

  test.afterEach(async () => {
    await resetAnnotationState()
  })

  test('Ctrl+K opens the palette and Escape closes it', async ({ page }) => {
    await expect(page.getByTestId('command-palette')).not.toBeVisible()

    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('command-palette')).toBeVisible()

    await page.getByTestId('command-palette-input').press('Escape')
    await expect(page.getByTestId('command-palette')).not.toBeVisible()
  })

  test('the palette fuzzy-matches commands', async ({ page }) => {
    await page.keyboard.press('Control+k')
    await page.getByTestId('command-palette-input').fill('drw')

    // "drw" is a subsequence of "Draw annotation"
    await expect(page.getByTestId('command-item-draw')).toBeVisible()
  })

  test('the palette finds annotations by label', async ({ page }) => {
    await fetch(`${SERVER}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shape: 'region',
        kind: 'module',
        label: 'Findable Annotation',
        members: []
      })
    })
    await openProject(page)

    await page.keyboard.press('Control+k')
    await page.getByTestId('command-palette-input').fill('Findable')

    await expect(page.getByText('Findable Annotation').first()).toBeVisible()
  })

  test('running the draw command enters annotate mode', async ({ page }) => {
    await page.keyboard.press('Control+k')
    await page.getByTestId('command-palette-input').fill('Draw')
    await page.getByTestId('command-item-draw').click()

    await expect(page.getByTestId('command-palette')).not.toBeVisible()
    await expect(page.getByTestId('annotate-hint')).toBeVisible()
  })
})

// ── Undo / redo ─────────────────────────────────────────────────────────────

test.describe('Undo and redo', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000)
    await resetAnnotationState()
    await openProject(page)
  })

  test.afterEach(async () => {
    await resetAnnotationState()
  })

  test('undo removes a just-drawn annotation and redo restores it', async ({ page }) => {
    await page.keyboard.press('a')

    const box = await page.getByTestId('graph-canvas').boundingBox()
    if (!box) return
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.7)
    await page.mouse.down()
    await page.mouse.up()

    await page.getByTestId('kind-input-kind').fill('undo-test')
    await page.keyboard.press('Enter')

    await waitForAnnotation((a) => a.kind === 'undo-test')

    // Undo through the store — the same path the keyboard shortcut uses
    await page.evaluate(() => (window as any).__graphcoder.undo())
    await expect.poll(async () => (await getAnnotations()).filter((a) => a.kind === 'undo-test').length).toBe(0)

    await page.evaluate(() => (window as any).__graphcoder.redo())
    await expect.poll(async () => (await getAnnotations()).filter((a) => a.kind === 'undo-test').length).toBe(1)
  })
})

// ── .gitignore preservation ─────────────────────────────────────────────────

test.describe('Project .gitignore is merged, not overwritten', () => {
  test.beforeEach(() => {
    test.setTimeout(120_000)
  })

  test('opening a project keeps user-added ignore rules', async ({ page }) => {
    const gitignorePath = path.join(fixturePath, '.graphcoder', '.gitignore')

    // A user rule that GraphCoder did not write
    const before = readFileSync(gitignorePath, 'utf-8')
    expect(before).toContain('annotations/')

    // Opening the project runs the temporal cache bootstrap, which used to
    // clobber this file with its own fixed contents.
    await openProject(page)

    const after = readFileSync(gitignorePath, 'utf-8')

    // The user rules survived
    expect(after).toContain('annotations/')
    expect(after).toContain('annotation-kinds.json')
    // GraphCoder's own rules are still present
    expect(after).toContain('temporal.sqlite')
    expect(after).toContain('temporal.sqlite-wal')
    expect(after).toContain('temporal.sqlite-shm')
  })
})
