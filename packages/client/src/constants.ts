import type { EdgeKind, NodeKind } from '@graphcoder/core'

// ── Node kind colours ─────────────────────────────────────────────────────────

export const NODE_KIND_FILL: Record<NodeKind, string> = {
  file: '#374151',
  module: '#374151',
  class: '#581c87',
  struct: '#581c87',
  interface: '#115e59',
  trait: '#115e59',
  protocol: '#115e59',
  function: '#1e40af',
  method: '#1e40af',
  property: '#3b3a2f',
  field: '#3b3a2f',
  variable: '#1c3a1e',
  constant: '#1c3a1e',
  enum: '#4a1942',
  enum_member: '#4a1942',
  type_alias: '#2d3748',
  namespace: '#2c3e50',
  parameter: '#2d3748',
  import: '#1a2a2a',
  export: '#1a2a2a',
  route: '#1e3a5f',
  component: '#1e3a5f',
  union: '#2d3748'
}

export function nodeKindColor(kind: string | undefined): string {
  return NODE_KIND_FILL[(kind as NodeKind) ?? ''] ?? '#1f2937'
}

// ── Edge kind colours ─────────────────────────────────────────────────────────

export const EDGE_KIND_STROKE: Record<EdgeKind, string> = {
  contains: '#4b5563',
  calls: '#3b82f6',
  imports: '#9ca3af',
  exports: '#9ca3af',
  extends: '#a78bfa',
  implements: '#a78bfa',
  references: '#6b7280',
  type_of: '#60a5fa',
  returns: '#34d399',
  instantiates: '#f59e0b',
  overrides: '#f97316',
  decorates: '#ec4899'
}

export function edgeKindColor(kind: string | undefined): string {
  return EDGE_KIND_STROKE[(kind as EdgeKind) ?? ''] ?? '#4b5563'
}
