/**
 * Graph section — nodes and edges are managed directly in the core store
 * and updated by the project, view, and WebSocket sections.
 *
 * This module re-exports `state` and `setState` for consumers that need
 * access to the raw graph data without importing unrelated sections.
 */
export { state, setState } from './core.js'
