import { createEngine } from './lib/engine.js'

export const name = 'character-core'
export const inject = ['systemPrompt']

/**
 * Mount inside an agent preset. The engine registers the persona prefix/suffix
 * and the per-turn state block in the preset's scope, so it only affects
 * sessions that select this preset.
 */
export function apply(ctx) {
  createEngine(ctx)
}
