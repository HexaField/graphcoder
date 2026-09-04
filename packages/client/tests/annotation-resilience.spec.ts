/**
 * Annotation resilience tests — malformed annotation JSON on disk
 * must load with safe defaults and render without crash.
 *
 * Regression tests for:
 *   - loadAnnotation/loadAllAnnotations: raw JSON.parse with no field
 *     validation → undefined members/anchor propagate to the client
 *   - BoundaryOverlay: annotation.members undefined → TypeError
 *   - MarkerOverlay: annotation.members/anchor undefined → TypeError
 *
 * Strategy: write annotation JSON files with missing fields directly
 * to the fixture's .graphcoder/annotations/ directory. Verify the
 * server normalizes them on load (members: [], anchor: {x:0,y:0,...})
 * and the canvas renders without crash.
 */
import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = process.env.FIXTURE_PATH ?? path.resolve(__dirname, '../../../test-fixtures/sample-project')
const annotationsDir = path.join(fixturePath, '.graphcoder', 'annotations')

const SERVER = process.env.VITE_API_URL ?? 'http://localhost:3001'

/** Close the server's current project — resets server state between test suites. */
async function closeServerProject(): Promise<void> {
  await fetch(`${SERVER}/api/projects/close`, { method: 'POST' })
}

/** Delete all annotations via the API. */
async function deleteAllAnnotations(): Promise<void> {
  const res = await fetch(`${SERVER}/api/annotations`)
  if (!res.ok) return
  const data = (await res.json()) as { annotations: Array<{ id: string }> }
  for (const ann of data.annotations) {
    await fetch(`${SERVER}/api/annotations/${ann.id}`, { method: 'DELETE' })
  }
}

/** Open a project and wait for the graph to render. */
async function openProject(page: Page, projectPath = fixturePath): Promise<void> {
  await page.goto('/')
  await page.getByTestId('project-path-input').fill(projectPath)
  await page.getByTestId('open-project-btn').click()
  await page.waitForSelector('[data-testid="project-stats"]', { timeout: 90_000 })
  await page.waitForSelector('[data-testid="hierarchy-panel"] [data-nodeid]', { timeout: 30_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="graph-canvas"] .absolute span'), {
    timeout: 30_000
  })
}

/** Write a raw JSON object as an annotation file on disk. */
function writeAnnotationFile(id: string, data: Record<string, unknown>): void {
  if (!existsSync(annotationsDir)) {
    mkdirSync(annotationsDir, { recursive: true })
  }
  writeFileSync(path.join(annotationsDir, `${id}.json`), JSON.stringify(data) + '\n', 'utf-8')
}

// ── Setup ────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  await closeServerProject()
})

// ── Malformed annotation tests ──────────────────────────────────────────────

test.describe('Annotation resilience (malformed JSON on disk)', () => {
  test.beforeEach(async () => {
    test.setTimeout(120_000)
    await closeServerProject()
    await deleteAllAnnotations()
  })

  test.afterEach(async () => {
    await deleteAllAnnotations()
  })

  // ── Regression: missing members field normalized to empty array ─────────

  test('boundary annotation with missing members loads with members: []', async ({ page }) => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000001'

    // Write a boundary annotation missing the "members" field entirely
    writeAnnotationFile(id, {
      id,
      version: 1,
      kind: 'boundary',
      status: 'active',
      label: 'Missing Members',
      description: 'Annotation without members field',
      // members: INTENTIONALLY OMITTED — the bug
      steps: null,
      stepEdges: null,
      projectedDiff: null,
      dependencies: [],
      resolution: null,
      parentId: null,
      childIds: [],
      anchor: { x: 100, y: 100, memberLayout: null },
      author: 'human',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      reasoning: null
    })

    // Open the project so the server loads annotations from disk
    await openProject(page)

    // Fetch the annotation via API — the server MUST normalize missing fields
    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const annotation = (await res.json()) as Record<string, unknown>

    // members must be an array, not undefined/null
    expect(Array.isArray(annotation.members)).toBe(true)
    expect(annotation.members).toEqual([])

    // Canvas must still render — layout spinner gone, stats visible
    await expect(page.getByTestId('project-stats')).toBeVisible()
    await expect(page.getByTestId('graph-canvas')).toBeVisible()
  })

  // ── Regression: missing anchor field normalized to default ──────────────

  test('note annotation with missing members and anchor loads with defaults', async ({ page }) => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000002'

    // Write a note annotation missing both "members" and "anchor"
    writeAnnotationFile(id, {
      id,
      version: 1,
      kind: 'note',
      status: 'active',
      label: 'Missing Members + Anchor',
      description: 'Note without members or anchor',
      // members: INTENTIONALLY OMITTED
      steps: null,
      stepEdges: null,
      projectedDiff: null,
      dependencies: [],
      resolution: null,
      parentId: null,
      childIds: []
      // anchor: INTENTIONALLY OMITTED
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const annotation = (await res.json()) as Record<string, unknown>

    // members must be normalized to []
    expect(Array.isArray(annotation.members)).toBe(true)
    expect(annotation.members).toEqual([])

    // anchor must be normalized to default position
    expect(annotation.anchor).toBeTruthy()
    const anchor = annotation.anchor as { x: number; y: number; memberLayout: null }
    expect(typeof anchor.x).toBe('number')
    expect(typeof anchor.y).toBe('number')

    // Canvas renders without crash
    await expect(page.getByTestId('project-stats')).toBeVisible()
    await expect(page.getByTestId('graph-canvas')).toBeVisible()
  })

  // ── Regression: null members normalized to empty array ──────────────────

  test('question annotation with null members loads with members: []', async ({ page }) => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000003'

    // members explicitly set to null (bad PATCH or hand-edit)
    writeAnnotationFile(id, {
      id,
      version: 1,
      kind: 'question',
      status: 'active',
      label: 'Null Members',
      description: 'Question with null members',
      members: null,
      steps: null,
      stepEdges: null,
      projectedDiff: null,
      dependencies: [],
      resolution: null,
      parentId: null,
      childIds: [],
      anchor: { x: 50, y: 50, memberLayout: null }
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const annotation = (await res.json()) as Record<string, unknown>

    // null members must be normalized to []
    expect(Array.isArray(annotation.members)).toBe(true)
    expect(annotation.members).toEqual([])

    await expect(page.getByTestId('project-stats')).toBeVisible()
  })

  // ── Missing dependencies + childIds normalized to arrays ───────────────

  test('annotation with missing array fields loads with empty arrays', async ({ page }) => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000004'

    // Minimal annotation — almost every optional field missing
    writeAnnotationFile(id, {
      id,
      kind: 'boundary',
      status: 'proposed',
      label: 'Minimal Annotation'
      // everything else: OMITTED
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const annotation = (await res.json()) as Record<string, unknown>

    // All array fields must be normalized to []
    expect(Array.isArray(annotation.members)).toBe(true)
    expect(Array.isArray(annotation.dependencies)).toBe(true)
    expect(Array.isArray(annotation.childIds)).toBe(true)

    // Anchor must exist
    expect(annotation.anchor).toBeTruthy()

    // String fields must have defaults
    expect(typeof annotation.description).toBe('string')
    expect(typeof annotation.createdAt).toBe('string')
    expect(typeof annotation.updatedAt).toBe('string')
    expect(annotation.version).toBe(1)

    // Canvas renders
    await expect(page.getByTestId('project-stats')).toBeVisible()
    await expect(page.getByTestId('graph-canvas')).toBeVisible()
  })

  // ── loadAllAnnotations returns normalized list via GET /annotations ─────

  test('GET /annotations returns normalized annotations for all malformed files', async ({ page }) => {
    // Write three malformed annotations at once
    writeAnnotationFile('aaaaaaaa-bbbb-cccc-dddd-000000000005', {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000005',
      kind: 'boundary',
      label: 'No Members'
      // members, anchor, status, etc. all missing
    })
    writeAnnotationFile('aaaaaaaa-bbbb-cccc-dddd-000000000006', {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000006',
      kind: 'note',
      label: 'Null Arrays',
      members: null,
      dependencies: null,
      childIds: null
    })
    writeAnnotationFile('aaaaaaaa-bbbb-cccc-dddd-000000000007', {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000007',
      kind: 'question',
      label: 'String Not Array',
      members: 'not-an-array'
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { annotations: Array<Record<string, unknown>> }

    // All three should load (not crash the loader)
    const ids = data.annotations.map((a) => a.id)
    expect(ids).toContain('aaaaaaaa-bbbb-cccc-dddd-000000000005')
    expect(ids).toContain('aaaaaaaa-bbbb-cccc-dddd-000000000006')
    expect(ids).toContain('aaaaaaaa-bbbb-cccc-dddd-000000000007')

    // Every annotation must have members as an array
    for (const ann of data.annotations) {
      expect(Array.isArray(ann.members)).toBe(true)
      expect(Array.isArray(ann.dependencies)).toBe(true)
      expect(Array.isArray(ann.childIds)).toBe(true)
      expect(ann.anchor).toBeTruthy()
    }
  })
})
