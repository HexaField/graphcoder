import type { EdgeKind, NodeKind } from '../index.js'

export interface ArchDiff {
  version: 2
  base: string
  target: string
  diffHash: string
  operations: ArchOp[]
}

export type ArchOp =
  | { op: 'add_node'; node: NodeSnapshot }
  | { op: 'remove_node'; id: string; node: NodeSnapshot }
  | { op: 'modify_node'; id: string; prev: Partial<NodeProps>; next: Partial<NodeProps> }
  | { op: 'move_node'; id: string; from: { filePath: string }; to: { filePath: string; hint?: LocationHint } }
  | { op: 'add_edge'; edge: EdgeTuple }
  | { op: 'remove_edge'; edge: EdgeTuple }

export interface NodeSnapshot {
  id: string
  kind: NodeKind
  name: string
  qualifiedName: string
  filePath: string
  language: string
  signature?: string
  visibility?: 'public' | 'private' | 'protected' | 'internal'
  isExported?: boolean
  isAsync?: boolean
  isStatic?: boolean
  isAbstract?: boolean
  returnType?: string
  decorators?: string[]
  typeParameters?: string[]
  properties?: Record<string, string | number | boolean>
}

export type NodeProps = Omit<NodeSnapshot, 'id' | 'kind' | 'name' | 'signature'>

export interface EdgeTuple {
  source: string
  target: string
  kind: EdgeKind
}

export interface LocationHint {
  after?: string
  before?: string
  container?: string
}
