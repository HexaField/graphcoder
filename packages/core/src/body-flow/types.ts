export type CFNodeKind =
  | 'entry'
  | 'exit'
  | 'call'
  | 'block'
  | 'branch'
  | 'loop'
  | 'try'
  | 'catch'
  | 'finally'
  | 'guard'
  | 'await'

/** One call inside a `block` node — a run of sequential calls merged into a single node. */
export interface CFCall {
  label: string
  line: number
  targetNodeId?: string | null
  await?: boolean
}

export interface CFNode {
  id: string
  kind: CFNodeKind
  label: string
  /** 1-based source line */
  line: number
  column: number
  targetNodeId?: string | null
  condition?: string
  /** Present only on `block` nodes, in execution order */
  calls?: CFCall[]
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
