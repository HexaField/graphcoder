/**
 * Annotation resilience + migration tests.
 *
 * Covers two things the store must guarantee:
 *   1. Malformed v2 JSON on disk loads with safe defaults rather than
 *      propagating undefined into the canvas (which used to crash the
 *      overlay on annotation.members / annotation.anchor).
 *   2. v1 annotations (fixed `kind` enum, `steps`, `anchor`) migrate to the
 *      v2 model (`shape`, free-form `kind`, `geometry`) without data loss.
 */
import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { SERVER } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = process.env.FIXTURE_PATH ?? path.resolve(__dirname, '../../../test-fixtures/sample-project')
const annotationsDir = path.join(fixturePath, '.graphcoder', 'annotations')

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

function writeAnnotationFile(id: string, data: Record<string, unknown>): void {
  if (!existsSync(annotationsDir)) {
    mkdirSync(annotationsDir, { recursive: true })
  }
  writeFileSync(path.join(annotationsDir, `${id}.json`), JSON.stringify(data) + '\n', 'utf-8')
}

test.beforeAll(async () => {
  await closeServerProject()
})

// ── Malformed v2 data ───────────────────────────────────────────────────────

test.describe('Annotation resilience (malformed JSON on disk)', () => {
  test.beforeEach(async () => {
    test.setTimeout(120_000)
    await closeServerProject()
    await deleteAllAnnotations()
  })

  test.afterEach(async () => {
    await deleteAllAnnotations()
  })

  test('region annotation with missing members loads with members: []', async ({ page }) => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000001'
    writeAnnotationFile(id, {
      id,
      version: 2,
      shape: 'region',
      kind: 'module',
      status: 'active',
      label: 'Missing Members',
      description: 'Annotation without members field',
      // members: INTENTIONALLY OMITTED — the original crash
      geometry: { points: [], anchor: { x: 100, y: 100 } },
      parentId: null,
      childIds: [],
      author: 'human',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      reasoning: null
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const annotation = (await res.json()) as Record<string, unknown>

    expect(Array.isArray(annotation.members)).toBe(true)
    expect(annotation.members).toEqual([])

    await expect(page.getByTestId('project-stats')).toBeVisible()
    await expect(page.getByTestId('graph-canvas')).toBeVisible()
  })

  test('point annotation with missing geometry loads with a default anchor', async ({ page }) => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000002'
    writeAnnotationFile(id, {
      id,
      version: 2,
      shape: 'point',
      kind: '',
      status: 'active',
      label: 'Missing Geometry',
      description: 'Point without geometry'
      // members + geometry: INTENTIONALLY OMITTED
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const annotation = (await res.json()) as Record<string, unknown>

    expect(Array.isArray(annotation.members)).toBe(true)
    const geometry = annotation.geometry as { points: unknown; anchor: { x: number; y: number } }
    expect(geometry).toBeTruthy()
    expect(Array.isArray(geometry.points)).toBe(true)
    expect(typeof geometry.anchor.x).toBe('number')
    expect(typeof geometry.anchor.y).toBe('number')

    await expect(page.getByTestId('project-stats')).toBeVisible()
    await expect(page.getByTestId('graph-canvas')).toBeVisible()
  })

  test('annotation with null members loads with members: []', async ({ page }) => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000003'
    writeAnnotationFile(id, {
      id,
      version: 2,
      shape: 'point',
      kind: 'open question',
      status: 'active',
      label: 'Null Members',
      description: 'Annotation with null members',
      members: null,
      geometry: { points: [], anchor: { x: 50, y: 50 } }
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const annotation = (await res.json()) as Record<string, unknown>

    expect(Array.isArray(annotation.members)).toBe(true)
    expect(annotation.members).toEqual([])

    await expect(page.getByTestId('project-stats')).toBeVisible()
  })

  test('minimal annotation loads with every field defaulted', async ({ page }) => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000004'
    writeAnnotationFile(id, {
      id,
      shape: 'region',
      status: 'proposed',
      label: 'Minimal Annotation'
      // everything else: OMITTED
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const annotation = (await res.json()) as Record<string, unknown>

    expect(Array.isArray(annotation.members)).toBe(true)
    expect(Array.isArray(annotation.childIds)).toBe(true)
    expect(annotation.geometry).toBeTruthy()
    expect(typeof annotation.kind).toBe('string')
    expect(typeof annotation.description).toBe('string')
    expect(typeof annotation.createdAt).toBe('string')

    await expect(page.getByTestId('project-stats')).toBeVisible()
    await expect(page.getByTestId('graph-canvas')).toBeVisible()
  })

  test('GET /annotations normalizes every malformed file', async ({ page }) => {
    writeAnnotationFile('aaaaaaaa-bbbb-cccc-dddd-000000000005', {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000005',
      shape: 'region',
      label: 'No Members'
    })
    writeAnnotationFile('aaaaaaaa-bbbb-cccc-dddd-000000000006', {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000006',
      shape: 'point',
      label: 'Null Arrays',
      members: null,
      childIds: null
    })
    writeAnnotationFile('aaaaaaaa-bbbb-cccc-dddd-000000000007', {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000007',
      shape: 'polyline',
      label: 'String Not Array',
      members: 'not-an-array'
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { annotations: Array<Record<string, unknown>> }

    const ids = data.annotations.map((a) => a.id)
    expect(ids).toContain('aaaaaaaa-bbbb-cccc-dddd-000000000005')
    expect(ids).toContain('aaaaaaaa-bbbb-cccc-dddd-000000000006')
    expect(ids).toContain('aaaaaaaa-bbbb-cccc-dddd-000000000007')

    for (const ann of data.annotations) {
      expect(Array.isArray(ann.members)).toBe(true)
      expect(Array.isArray(ann.childIds)).toBe(true)
      expect(ann.geometry).toBeTruthy()
    }
  })
})

// ── v1 → v2 migration ────────────────────────────────────────────────────────

test.describe('v1 to v2 annotation migration', () => {
  test.beforeEach(async () => {
    test.setTimeout(120_000)
    await closeServerProject()
    await deleteAllAnnotations()
  })

  test.afterEach(async () => {
    await deleteAllAnnotations()
  })

  test('v1 boundary migrates to a region keeping its kind name', async ({ page }) => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000001'
    writeAnnotationFile(id, {
      id,
      version: 1,
      kind: 'boundary',
      status: 'active',
      label: 'Legacy Boundary',
      description: 'A v1 boundary annotation',
      members: ['abc123'],
      steps: null,
      stepEdges: null,
      projectedDiff: null,
      dependencies: [],
      resolution: null,
      parentId: null,
      childIds: [],
      anchor: {
        x: 42,
        y: 84,
        memberLayout: {
          points: [
            [0, 0],
            [10, 0],
            [10, 10]
          ]
        }
      },
      author: 'human',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      reasoning: null
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const ann = (await res.json()) as Record<string, unknown>

    // Structure moved into shape; the old kind survives as a user-defined kind
    expect(ann.shape).toBe('region')
    expect(ann.kind).toBe('boundary')
    expect(ann.version).toBe(2)
    expect(ann.members).toEqual(['abc123'])

    // anchor + memberLayout became geometry
    const geometry = ann.geometry as { points: number[][]; anchor: { x: number; y: number } }
    expect(geometry.anchor).toEqual({ x: 42, y: 84 })
    expect(geometry.points).toEqual([
      [0, 0],
      [10, 0],
      [10, 10]
    ])
  })

  test('v1 path migrates to a polyline with steps collapsed into ordered members', async ({ page }) => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000002'
    writeAnnotationFile(id, {
      id,
      version: 1,
      kind: 'path',
      status: 'active',
      label: 'Legacy Path',
      description: 'A v1 path annotation',
      // v1 kept the unordered bag here and the real order in steps
      members: ['zzz', 'yyy'],
      steps: [
        { id: 'step-0', label: 'Entry', description: '', architectureNodeId: 'node-a', stepKind: 'entry' },
        { id: 'step-1', label: 'Middle', description: '', architectureNodeId: 'node-b', stepKind: 'process' },
        { id: 'step-2', label: 'Exit', description: '', architectureNodeId: 'node-c', stepKind: 'exit' }
      ],
      stepEdges: [
        { from: 'step-0', to: 'step-1', label: null },
        { from: 'step-1', to: 'step-2', label: null }
      ],
      anchor: { x: 0, y: 0, memberLayout: null },
      author: 'human',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    await openProject(page)

    const res = await fetch(`${SERVER}/api/annotations/${id}`)
    expect(res.status).toBe(200)
    const ann = (await res.json()) as Record<string, unknown>

    expect(ann.shape).toBe('polyline')
    expect(ann.kind).toBe('path')
    // Step order wins over the v1 members bag — order is the path
    expect(ann.members).toEqual(['node-a', 'node-b', 'node-c'])
    // The parallel step structure is gone
    expect(ann.steps).toBeUndefined()
    expect(ann.stepEdges).toBeUndefined()
  })

  test('v1 note and question migrate to points', async ({ page }) => {
    writeAnnotationFile('bbbbbbbb-0000-0000-0000-000000000003', {
      id: 'bbbbbbbb-0000-0000-0000-000000000003',
      version: 1,
      kind: 'note',
      status: 'active',
      label: 'Legacy Note',
      members: [],
      anchor: { x: 5, y: 6, memberLayout: null }
    })
    writeAnnotationFile('bbbbbbbb-0000-0000-0000-000000000004', {
      id: 'bbbbbbbb-0000-0000-0000-000000000004',
      version: 1,
      kind: 'question',
      status: 'active',
      label: 'Legacy Question',
      members: [],
      anchor: { x: 7, y: 8, memberLayout: null }
    })

    await openProject(page)

    const noteRes = await fetch(`${SERVER}/api/annotations/bbbbbbbb-0000-0000-0000-000000000003`)
    const note = (await noteRes.json()) as Record<string, unknown>
    expect(note.shape).toBe('point')
    expect(note.kind).toBe('note')
    expect((note.geometry as { anchor: { x: number } }).anchor.x).toBe(5)

    const qRes = await fetch(`${SERVER}/api/annotations/bbbbbbbb-0000-0000-0000-000000000004`)
    const question = (await qRes.json()) as Record<string, unknown>
    expect(question.shape).toBe('point')
    expect(question.kind).toBe('question')
  })

  test('v1 statuses that no longer exist map onto the v2 set', async ({ page }) => {
    const cases: Array<[string, string, string]> = [
      ['bbbbbbbb-0000-0000-0000-000000000010', 'draft', 'active'],
      ['bbbbbbbb-0000-0000-0000-000000000011', 'applied', 'active'],
      ['bbbbbbbb-0000-0000-0000-000000000012', 'resolved', 'active'],
      ['bbbbbbbb-0000-0000-0000-000000000013', 'proposed', 'proposed'],
      ['bbbbbbbb-0000-0000-0000-000000000014', 'stale', 'stale']
    ]

    for (const [id, v1Status] of cases) {
      writeAnnotationFile(id, {
        id,
        version: 1,
        kind: 'note',
        status: v1Status,
        label: `Legacy ${v1Status}`,
        members: [],
        anchor: { x: 0, y: 0, memberLayout: null }
      })
    }

    await openProject(page)

    for (const [id, v1Status, expected] of cases) {
      const res = await fetch(`${SERVER}/api/annotations/${id}`)
      const ann = (await res.json()) as { status: string }
      expect(ann.status, `v1 status "${v1Status}" should map to "${expected}"`).toBe(expected)
    }
  })

  test('migrated kinds appear in the kind registry with colours', async ({ page }) => {
    writeAnnotationFile('bbbbbbbb-0000-0000-0000-000000000020', {
      id: 'bbbbbbbb-0000-0000-0000-000000000020',
      version: 1,
      kind: 'boundary',
      status: 'active',
      label: 'Legacy',
      members: [],
      anchor: { x: 0, y: 0, memberLayout: null }
    })

    await openProject(page)

    // The registry reconciles against kinds actually in use
    const res = await fetch(`${SERVER}/api/annotation-kinds`)
    expect(res.status).toBe(200)
    const { kinds } = (await res.json()) as { kinds: Array<{ name: string; color: string }> }

    const boundary = kinds.find((k) => k.name === 'boundary')
    expect(boundary).toBeTruthy()
    expect(boundary!.color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
