export type { CFNode, CFNodeKind, CFCall, CFEdge, CFEdgeKind, BodyFlow } from './types.js'
export { sliceBodyFlow, flowSuccessors, type BodyFlowSlice } from './slice.js'

/** Graph node kinds whose source body can expand into a body flow. */
export const BODY_FLOW_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'route', 'component'])
