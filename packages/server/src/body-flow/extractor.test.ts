import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@colbymchenry/codegraph'
import type { BodyFlow } from '@graphcoder/core'
import { extractBodyFlow } from './extractor.js'
import { parseSource } from './parser.js'

const src = (...lines: string[]) => lines.join('\n')

interface Target {
  line?: number
  column?: number
  name?: string
  edges?: Edge[]
}

function extract(language: string, source: string, target: Target = {}): BodyFlow {
  const tree = parseSource(source, language)
  if (!tree) throw new Error(`no grammar for ${language}`)
  const node = {
    id: 'fn',
    kind: 'function',
    name: target.name ?? '',
    startLine: target.line ?? 1,
    endLine: source.split('\n').length,
    startColumn: target.column ?? 0
  } as Node
  const flow = extractBodyFlow(node, target.edges ?? [], tree, language)
  if (!flow) throw new Error('no body flow extracted')
  return flow
}

/** Edges as sorted `source -kind-> target` lines; block nodes show their calls in brackets. */
function edges(flow: BodyFlow): string[] {
  const label = new Map(
    flow.nodes.map((n) => [n.id, n.calls ? `[${n.calls.map((c) => c.label).join(', ')}]` : n.label])
  )
  return flow.edges.map((e) => `${label.get(e.source)} -${e.kind}-> ${label.get(e.target)}`).sort()
}

const sorted = (lines: string[]) => [...lines].sort()

function callEdge(line: number, column: number, name: string, target: string): Edge {
  return { source: 'fn', target, kind: 'calls', line, column, metadata: { refName: name } }
}

describe('extractBodyFlow — TypeScript', () => {
  it('gives an if without else a false edge that skips to the next statement', () => {
    const flow = extract('typescript', src('function f(x) {', '  a()', '  if (x) {', '    b()', '  }', '  c()', '}'))
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> a',
        'a -next-> if (x)',
        'if (x) -true-> b',
        'if (x) -false-> c',
        'b -next-> c',
        'c -next-> exit'
      ])
    )
    expect(flow.nodes.find((n) => n.label === 'a')!.line).toBe(2)
  })

  it('merges both arms of an if/else into the next statement', () => {
    const flow = extract(
      'typescript',
      src('function f(x) {', '  if (x) {', '    a()', '  } else {', '    b()', '  }', '  c()', '}')
    )
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> if (x)',
        'if (x) -true-> a',
        'if (x) -false-> b',
        'a -next-> c',
        'b -next-> c',
        'c -next-> exit'
      ])
    )
  })

  it('marks early returns as guards but not the return that ends the function', () => {
    const flow = extract('typescript', src('function f(x) {', '  if (!x) return null', '  return g(x)', '}'))
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> if (!x)',
        'if (!x) -true-> return null',
        'return null -next-> exit',
        'if (!x) -false-> g',
        'g -next-> exit'
      ])
    )
    expect(flow.nodes.filter((n) => n.kind === 'guard')).toHaveLength(1)
  })

  it('routes continue to the loop head and break past the loop', () => {
    const flow = extract(
      'typescript',
      src(
        'function f(items) {',
        '  for (const item of items) {',
        '    if (skip(item)) continue',
        '    if (done(item)) break',
        '    handle(item)',
        '  }',
        '  finish()',
        '}'
      )
    )
    const loop = 'for (const item of items)'
    expect(edges(flow)).toEqual(
      sorted([
        `f -next-> ${loop}`,
        `${loop} -loop_body-> if (skip(item))`,
        `if (skip(item)) -true-> ${loop}`,
        'if (skip(item)) -false-> if (done(item))',
        'if (done(item)) -false-> handle',
        `handle -loop_back-> ${loop}`,
        `${loop} -loop_exit-> finish`,
        'if (done(item)) -true-> finish',
        'finish -next-> exit'
      ])
    )
  })

  it('turns a switch into a case ladder with fallthrough, break, and default', () => {
    const flow = extract(
      'typescript',
      src(
        'function f(k) {',
        '  switch (k) {',
        '    case 1:',
        '      a()',
        '    case 2:',
        '      b()',
        '      break',
        '    default:',
        '      c()',
        '  }',
        '  d()',
        '}'
      )
    )
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> case 1',
        'case 1 -true-> a',
        'case 1 -false-> case 2',
        'case 2 -true-> b',
        'a -next-> b',
        'case 2 -false-> c',
        'b -next-> d',
        'c -next-> d',
        'd -next-> exit'
      ])
    )
    expect(flow.nodes.find((n) => n.label === 'case 2')!.condition).toBe('k: case 2')
  })

  it('wires try, catch, and finally', () => {
    const flow = extract(
      'typescript',
      src(
        'async function f() {',
        '  try {',
        '    await load()',
        '  } catch (e) {',
        '    report(e)',
        '  } finally {',
        '    cleanup()',
        '  }',
        '  done()',
        '}'
      )
    )
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> try',
        'try -try_body-> await load',
        'try -catch_entry-> catch (e)',
        'catch (e) -next-> report',
        'await load -finally_entry-> finally',
        'report -finally_entry-> finally',
        'finally -next-> cleanup',
        'cleanup -next-> done',
        'done -next-> exit'
      ])
    )
    expect(flow.nodes.find((n) => n.label === 'await load')!.kind).toBe('await')
  })

  it('unfolds a promise chain into execution order', () => {
    const flow = extract(
      'typescript',
      src('function f() {', '  return fetchData()', '    .then((r) => parse(r))', '    .catch(handleError)', '}')
    )
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> fetchData',
        'fetchData -next-> parse',
        'fetchData -catch_entry-> .catch()',
        '.catch() -next-> handleError',
        'parse -next-> exit',
        'handleError -next-> exit'
      ])
    )
  })

  it('hangs .catch() off the root call, not a linked call in its arguments', () => {
    const flow = extract('typescript', src('function f() {', '  fetch(getUrl()).catch(recover)', '}'), {
      edges: [callEdge(2, 8, 'getUrl', 'g:getUrl')]
    })
    expect(edges(flow)).toContain('fetch -catch_entry-> .catch()')
  })

  it('ends a callback at its own returns instead of drawing guards', () => {
    const flow = extract(
      'typescript',
      src(
        'function f() {',
        '  return load().then((r) => {',
        '    if (!r) return null',
        '    return use(r)',
        '  })',
        '}'
      )
    )
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> load',
        'load -next-> if (!r)',
        'if (!r) -true-> exit',
        'if (!r) -false-> use',
        'use -next-> exit'
      ])
    )
    expect(flow.nodes.some((n) => n.kind === 'guard')).toBe(false)
  })

  it('drops branches and loops that contain no calls or jumps', () => {
    const flow = extract(
      'typescript',
      src(
        'function f(x) {',
        '  let y = 0',
        '  if (x) {',
        '    y = 1',
        '  }',
        '  for (const i of x) {',
        '    y += i',
        '  }',
        '  g(y)',
        '}'
      )
    )
    expect(edges(flow)).toEqual(['f -next-> g', 'g -next-> exit'])
  })

  it('draws a ternary as a branch only when its arms make calls', () => {
    const flow = extract(
      'typescript',
      src('function f(x) {', '  const v = x ? a() : b()', '  const w = x ? 1 : 2', '  c(v, w)', '}')
    )
    expect(edges(flow)).toEqual(
      sorted(['f -next-> x ?', 'x ? -true-> a', 'x ? -false-> b', 'a -next-> c', 'b -next-> c', 'c -next-> exit'])
    )
  })

  it('resolves targets, keeps linked nested calls, and merges a run of three calls into a block', () => {
    const flow = extract('typescript', src('function f() {', '  save(transform(load()), JSON.stringify(x))', '}'), {
      edges: [
        callEdge(2, 2, 'save', 'g:save'),
        callEdge(2, 7, 'transform', 'g:transform'),
        callEdge(2, 17, 'load', 'g:load')
      ]
    })
    expect(edges(flow)).toEqual(['[load, transform, save] -next-> exit', 'f -next-> [load, transform, save]'])
    const block = flow.nodes.find((n) => n.kind === 'block')!
    expect(block.calls!.map((c) => c.targetNodeId)).toEqual(['g:load', 'g:transform', 'g:save'])
  })

  it('tells apart same-named calls on one line by column', () => {
    const flow = extract('typescript', src('function f() {', '  a.get(x); b.get(y)', '}'), {
      edges: [callEdge(2, 2, 'get', 'A.get'), callEdge(2, 12, 'get', 'B.get')]
    })
    const target = (label: string) => flow.nodes.find((n) => n.label === label)!.targetNodeId
    expect(target('a.get')).toBe('A.get')
    expect(target('b.get')).toBe('B.get')
  })

  it('resolves route-handler calls that CodeGraph pins to the route line', () => {
    const flow = extract(
      'typescript',
      src("router.get('/x', async (req, res) => {", '  const data = await load(req)', '  res.json(data)', '})'),
      { edges: [callEdge(1, 0, 'load', 'g:load')] }
    )
    expect(flow.nodes.find((n) => n.label === 'await load')!.targetNodeId).toBe('g:load')
    expect(flow.nodes.find((n) => n.label === 'res.json')!.targetNodeId).toBeNull()
  })

  it('links fetch() to its route through the HTTP bridge edge', () => {
    const route: Edge = {
      source: 'fn',
      target: 'route:things',
      kind: 'calls',
      metadata: { synthetic: true, httpMethod: 'GET', matchedPath: '/things/:id' }
    }
    const flow = extract(
      'typescript',
      src(
        'async function fetchThing(id) {',
        '  const res = await fetch(`${API}/api/things/${id}`)',
        '  return res.json()',
        '}'
      ),
      { edges: [route] }
    )
    expect(flow.nodes.find((n) => n.label === 'await fetch')!.targetNodeId).toBe('route:things')
  })

  it('filters logging and formats a multi-line generic signature', () => {
    const flow = extract(
      'typescript',
      src(
        'export async function handleResponse<T>(',
        '  res: Response',
        '): Promise<T> {',
        "  console.log('x')",
        "  logger.info('y')",
        '  const body = await res.json()',
        '  return body as T',
        '}'
      ),
      { column: 7 }
    )
    expect(flow.signature).toBe('async function handleResponse<T>(res: Response): Promise<T>')
    expect(edges(flow)).toEqual(['await res.json -next-> exit', 'handleResponse -next-> await res.json'])
  })

  it('picks the right function when several start on the same line', () => {
    const flow = extract('typescript', 'const a = () => first(), b = () => second()', { name: 'b' })
    expect(edges(flow)).toEqual(['b -next-> second', 'second -next-> exit'])
  })
})

describe('extractBodyFlow — Python', () => {
  it('handles elif chains, raise, loop break, try/except/else/finally, and match', () => {
    const flow = extract(
      'python',
      src(
        'async def handle(data) -> str:',
        '    if not data:',
        '        raise ValueError("empty")',
        '    elif data == 1:',
        '        a()',
        '    else:',
        '        b()',
        '    for x in data:',
        '        if x:',
        '            break',
        '        c(x)',
        '    try:',
        '        r = await fetch(data)',
        '    except KeyError as e:',
        '        d(e)',
        '    else:',
        '        e2()',
        '    finally:',
        '        f()',
        '    match data:',
        '        case 1:',
        '            g()',
        '        case _:',
        '            h()',
        '    return r'
      )
    )
    expect(flow.signature).toBe('async def handle(data) -> str')
    expect(edges(flow)).toEqual(
      sorted([
        'handle -next-> if not data',
        'if not data -true-> raise ValueError("empty")',
        'raise ValueError("empty") -next-> exit',
        'if not data -false-> elif data == 1',
        'elif data == 1 -true-> a',
        'elif data == 1 -false-> b',
        'a -next-> for x in data',
        'b -next-> for x in data',
        'for x in data -loop_body-> if x',
        'if x -false-> c',
        'c -loop_back-> for x in data',
        'for x in data -loop_exit-> try',
        'if x -true-> try',
        'try -try_body-> await fetch',
        'await fetch -next-> e2',
        'try -catch_entry-> except KeyError as e',
        'except KeyError as e -next-> d',
        'e2 -finally_entry-> finally',
        'd -finally_entry-> finally',
        'finally -next-> f',
        'f -next-> case 1',
        'case 1 -true-> g',
        'case 1 -false-> h',
        'g -next-> exit',
        'h -next-> exit'
      ])
    )
  })
})

describe('extractBodyFlow — Python with', () => {
  it('keeps a final return inside a with block as a normal exit', () => {
    const flow = extract(
      'python',
      src('def load(path):', '    with open(path) as handle:', '        return handle.read()')
    )
    expect(edges(flow)).toEqual(['handle.read -next-> exit', 'load -next-> open', 'open -next-> handle.read'])
  })
})

describe('extractBodyFlow — Go', () => {
  it('handles else-if, continue, switch fallthrough, defer, and early returns', () => {
    const flow = extract(
      'go',
      src(
        'package main',
        '',
        'func (s *Server) handle(data []byte) (string, error) {',
        '\tif data == nil {',
        '\t\treturn "", fmt.Errorf("empty")',
        '\t} else if len(data) == 1 {',
        '\t\ta()',
        '\t} else {',
        '\t\tb()',
        '\t}',
        '\tfor _, x := range data {',
        '\t\tif x == 0 {',
        '\t\t\tcontinue',
        '\t\t}',
        '\t\tc(x)',
        '\t}',
        '\tswitch len(data) {',
        '\tcase 1, 2:',
        '\t\tg()',
        '\t\tfallthrough',
        '\tcase 3:',
        '\t\th()',
        '\tdefault:',
        '\t\ti()',
        '\t}',
        '\tdefer k()',
        '\treturn s.render(data), nil',
        '}'
      ),
      { line: 3 }
    )
    const loop = 'for _, x := range data'
    const guard = 'return "", fmt.Errorf("empty")'
    expect(flow.signature).toBe('func (s *Server) handle(data []byte) (string, error)')
    expect(edges(flow)).toEqual(
      sorted([
        'handle -next-> if data == nil',
        'if data == nil -true-> fmt.Errorf',
        `fmt.Errorf -next-> ${guard}`,
        `${guard} -next-> exit`,
        'if data == nil -false-> if len(data) == 1',
        'if len(data) == 1 -true-> a',
        'if len(data) == 1 -false-> b',
        `a -next-> ${loop}`,
        `b -next-> ${loop}`,
        `${loop} -loop_body-> if x == 0`,
        `if x == 0 -true-> ${loop}`,
        'if x == 0 -false-> c',
        `c -loop_back-> ${loop}`,
        `${loop} -loop_exit-> case 1, 2`,
        'case 1, 2 -true-> g',
        'case 1, 2 -false-> case 3',
        'case 3 -true-> h',
        'g -next-> h',
        'case 3 -false-> i',
        'h -next-> defer k',
        'i -next-> defer k',
        'defer k -next-> s.render',
        's.render -next-> exit'
      ])
    )
  })

  it('treats panic as a guard', () => {
    const flow = extract('go', src('func f(x int) {', '\tif x < 0 {', '\t\tpanic("neg")', '\t}', '\tg()', '}'))
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> if x < 0',
        'if x < 0 -true-> panic("neg")',
        'panic("neg") -next-> exit',
        'if x < 0 -false-> g',
        'g -next-> exit'
      ])
    )
  })
})

describe('extractBodyFlow — Rust', () => {
  it('handles early return, loops, await, and_then/or_else chains, loop break, and match', () => {
    const flow = extract(
      'rust',
      src(
        'impl Server {',
        '    pub async fn handle(&self, data: &[u8]) -> Result<String, Error> {',
        '        if data.is_empty() {',
        '            return Err(Error::new("empty"));',
        '        }',
        '        for x in data.iter() {',
        '            c(x);',
        '        }',
        '        let v = fetch(data).await?;',
        '        let out = parse(data).and_then(|p| check(p)).or_else(recover);',
        '        loop { if d() { break; } }',
        '        match v {',
        '            1 => g(),',
        '            _ => { h(); }',
        '        }',
        '        self.render(data)',
        '    }',
        '}'
      ),
      { line: 2, column: 4 }
    )
    const guard = 'return Err(Error::new("empty"))'
    const loop = 'for x in data.iter()'
    expect(flow.signature).toBe('async fn handle(&self, data: &[u8]) -> Result<String, Error>')
    expect(edges(flow)).toEqual(
      sorted([
        'handle -next-> if data.is_empty()',
        `if data.is_empty() -true-> ${guard}`,
        `${guard} -next-> exit`,
        `if data.is_empty() -false-> ${loop}`,
        `${loop} -loop_body-> c`,
        `c -loop_back-> ${loop}`,
        `${loop} -loop_exit-> await fetch`,
        'await fetch -next-> parse',
        'parse -next-> check',
        'parse -catch_entry-> .or_else()',
        '.or_else() -next-> recover',
        'check -next-> loop',
        'recover -next-> loop',
        'loop -loop_body-> if d()',
        'if d() -false-> loop',
        'if d() -true-> 1 =>',
        '1 => -true-> g',
        '1 => -false-> h',
        'g -next-> self.render',
        'h -next-> self.render',
        'self.render -next-> exit'
      ])
    )
  })

  it('gives an exhaustive match no fall-out edge', () => {
    const flow = extract(
      'rust',
      src(
        'fn f(r: Result<u8, E>) -> u8 {',
        '    match r {',
        '        Ok(v) => use_it(v),',
        '        Err(e) => fail(e),',
        '    }',
        '}'
      )
    )
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> Ok(v) =>',
        'Ok(v) => -true-> use_it',
        'Ok(v) => -false-> Err(e) =>',
        'Err(e) => -true-> fail',
        'use_it -next-> exit',
        'fail -next-> exit'
      ])
    )
  })

  it('branches on let-else', () => {
    const flow = extract(
      'rust',
      src('fn f(v: Option<u8>) {', '    let Some(x) = v else { return; };', '    g(x);', '}')
    )
    expect(edges(flow)).toEqual(
      sorted([
        'f -next-> let Some(x) else',
        'let Some(x) else -false-> return',
        'return -next-> exit',
        'let Some(x) else -true-> g',
        'g -next-> exit'
      ])
    )
  })
})
