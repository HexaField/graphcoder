/**
 * NodeAnnotations — reverse-navigation panel.
 *
 * When a node gets selected on the canvas, this component displays every
 * annotation whose `members` array contains that node's semantic ID.
 * Click an annotation to select it (highlights on canvas + scrolls sidebar).
 */
import { type Component, createMemo, For, Show } from 'solid-js'
import type { Annotation } from '@graphcoder/core'
import { nodeSemanticId } from '@graphcoder/core'
import { state, selectAnnotation, kindColor } from '../state/store.js'

export const NodeAnnotations: Component = () => {
  const selectedNode = () => {
    const id = state.selectedNodeId
    if (!id) return null
    return state.viewNodes.find((n) => n.id === id) ?? null
  }

  const semanticId = createMemo(() => {
    const node = selectedNode()
    if (!node) return null
    return nodeSemanticId(node)
  })

  /** All annotations that reference the selected node */
  const referencing = createMemo((): Annotation[] => {
    const sid = semanticId()
    if (!sid) return []
    return state.annotations.filter((a) => a.status !== 'dismissed' && a.members.includes(sid))
  })

  const isSelected = (id: string) => state.selectedAnnotationId === id

  return (
    <Show when={referencing().length > 0}>
      <div class="border-t border-gray-200 dark:border-gray-700 px-3 py-2" data-testid="node-annotations">
        <div class="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
          Annotations ({referencing().length})
        </div>
        <div class="flex flex-col gap-0.5">
          <For each={referencing()}>
            {(ann) => {
              const color = () => kindColor(ann.kind)
              return (
                <button
                  class="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-left
                         hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors w-full"
                  classList={{
                    'bg-blue-50 dark:bg-blue-900/30': isSelected(ann.id)
                  }}
                  onClick={() => selectAnnotation(isSelected(ann.id) ? null : ann.id)}
                  title={ann.description || ann.label}
                >
                  <span class="w-2 h-2 rounded-full flex-shrink-0" style={{ 'background-color': color() }} />
                  <span class="text-gray-400 dark:text-gray-500 flex-shrink-0">{ann.kind || '—'}</span>
                  <span class="truncate text-gray-700 dark:text-gray-300">{ann.label}</span>
                  <span class="ml-auto text-[10px] text-gray-400 flex-shrink-0">{ann.members.length}</span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}
