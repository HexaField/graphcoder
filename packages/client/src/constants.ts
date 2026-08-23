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
  file: '#dde6f0',
  module: '#dde6f0',
  class: '#ede9fe',
  struct: '#ede9fe',
  interface: '#ccfbf1',
  trait: '#ccfbf1',
  protocol: '#ccfbf1',
  function: '#dbeafe',
  method: '#dbeafe',
  property: '#fef9c3',
  field: '#fef9c3',
  variable: '#dcfce7',
  constant: '#dcfce7',
  enum: '#fce7f3',
  enum_member: '#fce7f3',
  type_alias: '#e8ecf0',
  namespace: '#e0f2fe',
  parameter: '#e8ecf0',
  import: '#f0fdf4',
  export: '#f0fdf4',
  route: '#dbeafe',
  component: '#dbeafe',
  union: '#e8ecf0'
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
