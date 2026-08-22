export type NodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'protocol'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'route'
  | 'component'
  | 'union'

export type EdgeKind =
  | 'contains'
  | 'calls'
  | 'imports'
  | 'exports'
  | 'extends'
  | 'implements'
  | 'references'
  | 'type_of'
  | 'returns'
  | 'instantiates'
  | 'overrides'
  | 'decorates'

export interface GraphNode {
  id: string
  kind: NodeKind
  name: string
  qualifiedName: string
  filePath: string
  language: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  docstring?: string
  signature?: string
  visibility?: 'public' | 'private' | 'protected' | 'internal'
  isExported?: boolean
  isAsync?: boolean
  isStatic?: boolean
  isAbstract?: boolean
  decorators?: string[]
  typeParameters?: string[]
  returnType?: string
  updatedAt: number
}

export interface GraphEdge {
  source: string
  target: string
  kind: EdgeKind
  metadata?: Record<string, unknown>
  line?: number
  column?: number
  provenance?: 'tree-sitter' | 'scip' | 'heuristic'
}

export interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface NodeDetail {
  node: GraphNode
  incoming: GraphEdge[]
  outgoing: GraphEdge[]
  code: string | null
}

export interface Subgraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  rootId?: string
}

export interface ProjectStats {
  nodeCount: number
  edgeCount: number
  fileCount: number
}

export interface FileEntry {
  filePath: string
  language: string
  nodeCount: number
  nodes: GraphNode[]
}

export interface SearchResultItem {
  node: GraphNode
  score: number
}

// View modes for the canvas
export type ViewMode = 'module-dependency' | 'call-graph' | 'impact-radius'
