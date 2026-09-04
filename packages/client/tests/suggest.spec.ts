/**
 * E2E tests for Phase 3b — AI-Proposed Annotations.
 *
 * Exercises the full suggest → refine → accept pipeline:
 *   1. POST /api/annotations/suggest (test provider, 202 + async)
 *   2. Poll for the proposed annotation to appear
 *   3. Verify proposed annotation fields + status
 *   4. POST /api/annotations/:id/refine → verify updated description
 *   5. GET /api/annotations/:id/conversation → verify conversation log
 *   6. PATCH /api/annotations/:id with status: 'active' → accept
 *   7. DELETE cleanup
 *
 * Also verifies WebSocket notifications reach the browser client.
 */
import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = process.env.FIXTURE_PATH ?? path.resolve(__dirname, '../../../test-fixtures/sample-project')

const SERVER = process.env.VITE_API_URL ?? 'http://localhost:3001'

/** Close the server's current project — resets server state between test suites. */
async function closeServerProject(): Promise<void> {
  await fetch(`${SERVER}/api/projects/close`, { method: 'POST' })
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

/** Poll GET /api/annotations until a proposed annotation appears. */
async function waitForProposedAnnotation(timeoutMs = 15_000): Promise<{
  id: string
  shape: string
  kind: string
  label: string
  status: string
  description: string
  reasoning: string | null
  members: string[]
}> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${SERVER}/api/annotations`)
    if (res.ok) {
      const data = (await res.json()) as { annotations: Array<Record<string, unknown>> }
      const proposed = data.annotations.find((a) => a.status === 'proposed')
      if (proposed) return proposed as any
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`No proposed annotation appeared within ${timeoutMs}ms`)
}

/** Delete all annotations — cleanup helper. */
async function deleteAllAnnotations(): Promise<void> {
  const res = await fetch(`${SERVER}/api/annotations`)
  if (!res.ok) return
  const data = (await res.json()) as { annotations: Array<{ id: string }> }
  for (const ann of data.annotations) {
    await fetch(`${SERVER}/api/annotations/${ann.id}`, { method: 'DELETE' })
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  await closeServerProject()
})

// ── Suggest pipeline tests ───────────────────────────────────────────────────

test.describe('AI Suggest pipeline (Phase 3b)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000)
    await deleteAllAnnotations()
    await openProject(page)
  })

  test.afterEach(async () => {
    await deleteAllAnnotations()
  })

  // ── Test 1: POST /suggest returns 202 and an async proposal arrives ────

  test('suggest creates a proposed annotation via the test provider', async () => {
    // Request a suggestion — uses the test provider fallback (no config.json in fixture)
    const suggestRes = await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Math Utils',
        prompt: 'group the math utility functions',
        provider: 'test'
      })
    })

    expect(suggestRes.status).toBe(202)
    const suggestBody = (await suggestRes.json()) as { id: string; status: string }
    expect(suggestBody.status).toBe('processing')
    expect(suggestBody.id).toBeTruthy()

    // Wait for the async processing to complete — poll for the proposed annotation
    const proposed = await waitForProposedAnnotation()
    expect(proposed.status).toBe('proposed')
    expect(proposed.label).toBeTruthy()
    expect(proposed.shape).toBe('region') // test provider always returns a region
    expect(proposed.kind).toBe('module') // free-form kind coined by the provider
    expect(proposed.description).toContain('AI-suggested boundary')
    expect(proposed.reasoning).toContain('Test provider')
  })

  // ── Test 2: proposed annotation has resolved members ───────────────────

  test('proposed annotation resolves nodeRefs to semantic IDs', async () => {
    const suggestRes = await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Add Function',
        prompt: 'add multiply math',
        provider: 'test'
      })
    })
    expect(suggestRes.status).toBe(202)

    const proposed = await waitForProposedAnnotation()
    // The test provider uses context's matched nodes — the prompt "add multiply math"
    // should match functions in math.ts. Members should contain semantic IDs (64-char hex).
    expect(proposed.members.length).toBeGreaterThan(0)
    for (const member of proposed.members) {
      // Semantic IDs consist of 64 hex characters
      expect(member).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  // ── Test 3: refine updates the proposed annotation ─────────────────────

  test('refine updates the proposed annotation description', async () => {
    // Create proposal first
    await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Refine Target',
        prompt: 'add multiply',
        provider: 'test'
      })
    })

    const proposed = await waitForProposedAnnotation()
    const originalDescription = proposed.description

    // Refine it
    const refineRes = await fetch(`${SERVER}/api/annotations/${proposed.id}/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'also include the power function',
        provider: 'test'
      })
    })

    expect(refineRes.status).toBe(200)
    const refineBody = (await refineRes.json()) as {
      annotation: { id: string; description: string; status: string }
      conversation: { turns: Array<{ role: string; content: string }> }
    }

    // Annotation should still carry 'proposed' status
    expect(refineBody.annotation.status).toBe('proposed')
    // Description should differ from the original (test provider includes the user message)
    expect(refineBody.annotation.description).toContain('Refined:')
    expect(refineBody.annotation.description).not.toBe(originalDescription)

    // Conversation should have turns
    expect(refineBody.conversation.turns.length).toBeGreaterThanOrEqual(2)

    // Verify the persisted annotation matches
    const getRes = await fetch(`${SERVER}/api/annotations/${proposed.id}`)
    expect(getRes.status).toBe(200)
    const persisted = (await getRes.json()) as { description: string }
    expect(persisted.description).toBe(refineBody.annotation.description)
  })

  // ── Test 4: conversation endpoint returns the full log ─────────────────

  test('conversation endpoint returns the full conversation log', async () => {
    // Create + refine
    await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Conv Test',
        prompt: 'formatResult rectangleArea',
        provider: 'test'
      })
    })

    const proposed = await waitForProposedAnnotation()

    // Refine twice
    await fetch(`${SERVER}/api/annotations/${proposed.id}/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'first refinement', provider: 'test' })
    })

    await fetch(`${SERVER}/api/annotations/${proposed.id}/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'second refinement', provider: 'test' })
    })

    // Fetch conversation
    const convRes = await fetch(`${SERVER}/api/annotations/${proposed.id}/conversation`)
    expect(convRes.status).toBe(200)
    const convBody = (await convRes.json()) as {
      conversation: {
        annotationId: string
        provider: string
        turns: Array<{ role: string; content: string; timestamp: string; annotationDelta: unknown }>
      }
    }

    const conv = convBody.conversation
    expect(conv).not.toBeNull()
    expect(conv.annotationId).toBe(proposed.id)
    expect(conv.provider).toBe('test')

    // Should have: initial assistant + user1 + assistant1 + user2 + assistant2 = 5 turns
    expect(conv.turns.length).toBe(5)
    expect(conv.turns[0]!.role).toBe('assistant') // initial suggestion
    expect(conv.turns[1]!.role).toBe('user') // first refinement
    expect(conv.turns[2]!.role).toBe('assistant') // first response
    expect(conv.turns[3]!.role).toBe('user') // second refinement
    expect(conv.turns[4]!.role).toBe('assistant') // second response

    // Every turn should have a timestamp
    for (const turn of conv.turns) {
      expect(turn.timestamp).toBeTruthy()
      expect(new Date(turn.timestamp).getTime()).toBeGreaterThan(0)
    }
  })

  // ── Test 5: accept transitions proposed → active ───────────────────────

  test('accepting a proposed annotation changes status to active', async () => {
    await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Accept Target',
        prompt: 'processShape api',
        provider: 'test'
      })
    })

    const proposed = await waitForProposedAnnotation()
    expect(proposed.status).toBe('proposed')

    // Accept it — PATCH status to 'active'
    const patchRes = await fetch(`${SERVER}/api/annotations/${proposed.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' })
    })

    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { id: string; status: string }
    expect(patched.status).toBe('active')
    expect(patched.id).toBe(proposed.id)

    // Verify persistence
    const getRes = await fetch(`${SERVER}/api/annotations/${proposed.id}`)
    const persisted = (await getRes.json()) as { status: string }
    expect(persisted.status).toBe('active')
  })

  // ── Test 6: dismiss deletes the annotation ─────────────────────────────

  test('dismissing a proposed annotation removes it', async () => {
    await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Dismiss Target',
        prompt: 'add math function',
        provider: 'test'
      })
    })

    const proposed = await waitForProposedAnnotation()

    // Delete (dismiss)
    const deleteRes = await fetch(`${SERVER}/api/annotations/${proposed.id}`, {
      method: 'DELETE'
    })
    expect(deleteRes.status).toBe(200)

    // Should no longer exist
    const getRes = await fetch(`${SERVER}/api/annotations/${proposed.id}`)
    expect(getRes.status).toBe(404)
  })

  // ── Test 7: suggest with invalid body returns 400 ──────────────────────

  test('suggest with missing fields returns 400', async () => {
    const res1 = await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'No Prompt' })
    })
    expect(res1.status).toBe(400)

    const res2 = await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'No Label' })
    })
    expect(res2.status).toBe(400)
  })

  // ── Test 8: refine on nonexistent annotation returns 500 ───────────────

  test('refine on nonexistent annotation returns error', async () => {
    const res = await fetch(`${SERVER}/api/annotations/00000000-0000-0000-0000-000000000000/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'refine this' })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('not found')
  })

  // ── Test 9: conversation for annotation with no conversation returns null ──

  test('conversation endpoint returns null for annotation without conversation', async () => {
    // Create a manual annotation (no AI involvement — no conversation)
    const createRes = await fetch(`${SERVER}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shape: 'point',
        kind: 'note',
        label: 'Manual Note',
        members: [],
        description: 'A manually created note'
      })
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { id: string }

    const convRes = await fetch(`${SERVER}/api/annotations/${created.id}/conversation`)
    expect(convRes.status).toBe(200)
    const convBody = (await convRes.json()) as { conversation: null }
    expect(convBody.conversation).toBeNull()
  })

  // ── Test 10: WebSocket notifications reach the browser ─────────────────

  test('WebSocket delivers annotation_proposed notification to client', async ({ page }) => {
    // Set up a promise that resolves when the annotation_proposed WS message arrives.
    // The client reloads annotations on this event — we check for the proposed item.
    const wsPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 12_000)
        // Poll the store for a proposed annotation
        const poll = setInterval(() => {
          const gc = (window as any).__graphcoder
          if (!gc) return
          const annotations = gc.annotations as Array<{ status: string }>
          if (annotations.some((a) => a.status === 'proposed')) {
            clearTimeout(timeout)
            clearInterval(poll)
            resolve(true)
          }
        }, 200)
      })
    })

    // Trigger suggest
    await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'WS Test',
        prompt: 'multiply power math',
        provider: 'test'
      })
    })

    const arrived = await wsPromise
    expect(arrived).toBe(true)
  })

  // ── Test 11: Full round-trip: suggest → refine → accept → verify ──────

  test('full pipeline: suggest → refine → accept produces an active annotation', async () => {
    // 1. Suggest
    const suggestRes = await fetch(`${SERVER}/api/annotations/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Full Pipeline',
        prompt: 'rectangleArea rectanglePerimeter utils',
        provider: 'test'
      })
    })
    expect(suggestRes.status).toBe(202)

    // 2. Wait for proposal
    const proposed = await waitForProposedAnnotation()
    expect(proposed.status).toBe('proposed')
    expect(proposed.shape).toBe('region')

    // 3. Refine
    const refineRes = await fetch(`${SERVER}/api/annotations/${proposed.id}/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'include formatResult too',
        provider: 'test'
      })
    })
    expect(refineRes.status).toBe(200)
    const refined = ((await refineRes.json()) as { annotation: { description: string } }).annotation
    expect(refined.description).toContain('Refined:')

    // 4. Accept
    const acceptRes = await fetch(`${SERVER}/api/annotations/${proposed.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' })
    })
    expect(acceptRes.status).toBe(200)

    // 5. Verify final state
    const getRes = await fetch(`${SERVER}/api/annotations/${proposed.id}`)
    const final = (await getRes.json()) as {
      id: string
      status: string
      shape: string
      kind: string
      description: string
      reasoning: string | null
      members: string[]
    }

    expect(final.status).toBe('active')
    expect(final.shape).toBe('region')
    expect(final.description).toContain('Refined:')
    expect(final.reasoning).toBeTruthy()
    expect(final.members.length).toBeGreaterThan(0)

    // 6. Verify conversation log persisted the full exchange
    const convRes = await fetch(`${SERVER}/api/annotations/${proposed.id}/conversation`)
    const conv = ((await convRes.json()) as { conversation: { turns: Array<{ role: string }> } }).conversation
    // 3 turns: initial assistant + user refinement + assistant response
    expect(conv.turns.length).toBe(3)
  })
})
