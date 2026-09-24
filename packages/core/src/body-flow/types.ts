export type CFNodeKind = 'entry' | 'exit' | 'call' | 'branch' | 'loop' | 'try' | 'catch' | 'finally' | 'guard' | 'await'

export interface CFNode {
  id: string
  kind: CFNodeKind
  label: string
  line: number
  column: number
  targetNodeId?: string | null
  condition?: string
}

export type CFEdgeKind =
  | 'next'
  | 'true'
  | 'false'
  | 'loop_body'
  | 'loop_back'
  | 'loop_exit'
  | 'try_body'
  | 'catch_entry'
  | 'finally_entry'

export interface CFEdge {
  source: string
  target: string
  kind: CFEdgeKind
  label?: string
}

export interface BodyFlow {
  functionNodeId: string
  signature: string
  nodes: CFNode[]
  edges: CFEdge[]
}
