import type { EdgeKind, NodeKind } from '@graphcoder/core'

// ── Node kind colours — dark ──────────────────────────────────────────────────

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

// ── Node kind colours — light ─────────────────────────────────────────────────

export const NODE_KIND_FILL_LIGHT: Record<NodeKind, string> = {
  file: '#94a3b8',
  module: '#94a3b8',
  class: '#c4b5fd',
  struct: '#c4b5fd',
  interface: '#5eead4',
  trait: '#5eead4',
  protocol: '#5eead4',
  function: '#93c5fd',
  method: '#93c5fd',
  property: '#fde047',
  field: '#fde047',
  variable: '#86efac',
  constant: '#86efac',
  enum: '#f9a8d4',
  enum_member: '#f9a8d4',
  type_alias: '#94a3b8',
  namespace: '#7dd3fc',
  parameter: '#94a3b8',
  import: '#a7f3d0',
  export: '#a7f3d0',
  route: '#6ee7b7',
  component: '#93c5fd',
  union: '#94a3b8'
}

export function nodeKindColor(kind: string | undefined, dark = true): string {
  const map = dark ? NODE_KIND_FILL : NODE_KIND_FILL_LIGHT
  return map[(kind as NodeKind) ?? ''] ?? (dark ? '#1f2937' : '#dde6f0')
}

// ── Edge kind colours — dark ──────────────────────────────────────────────────

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

// ── Edge kind colours — light ─────────────────────────────────────────────────
// Slightly darker / more saturated where the dark palette was too muted on white.

export const EDGE_KIND_STROKE_LIGHT: Record<EdgeKind, string> = {
  contains: '#64748b',
  calls: '#2563eb',
  imports: '#64748b',
  exports: '#64748b',
  extends: '#7c3aed',
  implements: '#7c3aed',
  references: '#4b5563',
  type_of: '#1d4ed8',
  returns: '#059669',
  instantiates: '#d97706',
  overrides: '#ea580c',
  decorates: '#db2777'
}

export function edgeKindColor(kind: string | undefined, dark = true): string {
  const map = dark ? EDGE_KIND_STROKE : EDGE_KIND_STROKE_LIGHT
  return map[(kind as EdgeKind) ?? ''] ?? (dark ? '#4b5563' : '#64748b')
}
