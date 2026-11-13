import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyEvent,
  compactionTrigger,
  composeHandoff,
  driftLine,
  driftOf,
  emptyState,
  handoffFileName,
  normalizeConfig,
  normalizeState,
  projectionDefinition,
  viewOf,
} from '../lib/core.js'

const CONFIG = normalizeConfig({})

function headerEvent(model, effort, tools, maxTokens) {
  return {
    type: 'request/header',
    data: {
      header: {
        config: { provider: 'deepseek', model, reasoningEffort: effort, maxTokens },
        tools: tools.map(name => ({ name })),
      },
      reason: 'initial',
    },
  }
}

function userEvent(text) {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } }
}

function assistantEvent(text, usage) {
  return {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] }, usage },
  }
}

function toolCall(callId, name, args) {
  return { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } }
}

function toolResult(callId, isError) {
  return { type: 'tool/result', data: { message: { role: 'tool', toolCallId: callId, isError: isError === true } } }
}

function turnEnd(kind) {
  return { type: 'turn/end', data: { turn: 1, reason: { kind } } }
}

function fold(events, state = emptyState()) {
  let next = state
  for (const event of events) next = applyEvent(next, event, CONFIG)
  return next
}

test('compaction trigger mirrors dsh-compaction-basic arithmetic', () => {
  // min(0.8 * 200000, 200000 - 65536 - 65536) = min(160000, 68928)
  assert.equal(compactionTrigger(200000, 65536, CONFIG), 68928)
  // no reservation known: the ratio bound alone
  assert.equal(compactionTrigger(128000, null, CONFIG), 102400)
  // a collapsing budget falls back to the ratio bound instead of throwing
  assert.equal(compactionTrigger(128000, 65536, CONFIG), 102400)
  assert.equal(compactionTrigger(0, 65536, CONFIG), null)
  assert.equal(compactionTrigger(undefined, 65536, CONFIG), null)
})

test('state normalization is total and never throws on junk', () => {
  for (const junk of [null, undefined, 0, 'x', [], { files: 'nope' }, { calls: [[1]] }]) {
    const state = normalizeState(junk)
    assert.equal(typeof state, 'object')
    assert.equal(state.version, 1)
    assert.deepEqual(state.files, [])
  }
  const definition = projectionDefinition(CONFIG)
  assert.equal(definition.stateSchema.parse({ turns: 'many' }).turns, 0)
})

test('setup drift: model, effort and tool-set changes are detected and reverted', () => {
  const initial = fold([headerEvent('deepseek-flash', 'medium', ['read', 'write'])])
  const changed = fold([headerEvent('deepseek-pro', 'max', ['read', 'write', 'bash'])], initial)
  const drift = driftOf(changed.initial, changed.current)
  assert.equal(drift.changed, true)
  assert.deepEqual(drift.model, { from: 'deepseek/deepseek-flash', to: 'deepseek/deepseek-pro' })
  assert.equal(drift.toolsAdded.length, 1)
  assert.equal(drift.toolsAdded[0], 'bash')
  assert.match(driftLine(drift), /model deepseek-flash→deepseek-pro/)

  const back = fold([headerEvent('deepseek-flash', 'medium', ['read', 'write'])], initial)
  assert.equal(driftOf(back.initial, back.current).changed, false)
})

test('context pressure follows the last request usage', () => {
  const state = fold([
    { type: 'request/context', data: { provider: 'deepseek', model: 'flash', contextWindow: 200000 } },
    headerEvent('deepseek-flash', 'medium', [], undefined),
    userEvent('hello'),
    assistantEvent('ok', { inputTokens: 40000, outputTokens: 1200, cacheReadTokens: 800 }),
  ])
  const view = viewOf(state, CONFIG)
  assert.equal(view.context.window, 200000)
  assert.equal(view.context.compactionAt, 68928)
  assert.equal(view.context.pressure, 42000)
  assert.ok(view.context.ratio > 0.6 && view.context.ratio < 0.62)
})

test('a finished turn is only "done" when the reply says so', () => {
  const done = fold([userEvent('run the tests'), assistantEvent('All tests passed, exit 0.', {}), turnEnd('completed')])
  assert.equal(viewOf(done, CONFIG).done, true)
  const unfinished = fold([userEvent('run the tests'), assistantEvent('I need one more detail.', {}), turnEnd('completed')])
  assert.equal(viewOf(unfinished, CONFIG).done, false)
  const aborted = fold([userEvent('run the tests'), assistantEvent('All tests passed.', {}), turnEnd('aborted')])
  assert.equal(viewOf(aborted, CONFIG).done, false)
})

test('handoff from a six-tool-call session: file name, under 400 words, lists files', () => {
  const state = fold([
    headerEvent('deepseek-flash', 'medium', ['read', 'write', 'edit', 'pwsh']),
    userEvent('Add a handoff command to the coach plugin so sessions can be closed cleanly.'),
    assistantEvent('I decided to derive the handoff from the projection rather than replaying the log.', {}),
    toolCall('c1', 'read', { path: 'lib/core.js' }),
    toolCall('c2', 'write', { path: 'lib/index.js', content: '...' }),
    toolResult('c2', false),
    toolCall('c3', 'edit', { file_path: 'package.json' }),
    toolResult('c3', false),
    toolCall('c4', 'pwsh', { command: 'node --test test/core.test.mjs' }),
    toolResult('c4', false),
    toolCall('c5', 'pwsh', { command: 'node --check lib/index.js' }),
    toolResult('c5', false),
    toolCall('c6', 'pwsh', { command: 'npm test' }),
    toolResult('c6', true),
    toolCall('c7', 'todo_write', { todos: [{ content: 'write README', status: 'pending' }, { content: 'scaffold', status: 'completed' }] }),
    assistantEvent('All tests passed, exit 0.', {}),
    turnEnd('completed'),
  ])
  const handoff = composeHandoff(state, CONFIG)
  assert.ok(handoff.words > 0 && handoff.words <= 400, `words=${handoff.words}`)
  assert.match(handoff.markdown, /## Objective/)
  assert.match(handoff.markdown, /lib\/index\.js/)
  assert.match(handoff.markdown, /package\.json/)
  assert.doesNotMatch(handoff.markdown, /lib\/core\.js/, 'reads are not touches')
  assert.match(handoff.markdown, /## Verification/)
  assert.match(handoff.markdown, /npm test/)
  assert.match(handoff.markdown, /→ failed/)
  assert.match(handoff.markdown, /## Open items/)
  assert.match(handoff.markdown, /write README/)
  assert.doesNotMatch(handoff.markdown, /scaffold/)
  assert.match(handoffFileName(0), /^handoff-\d{8}-\d{4}\.md$/)
})

test('a huge session is trimmed to the word budget', () => {
  const state = fold([
    userEvent('word '.repeat(600)),
    toolCall('c1', 'pwsh', { command: 'node --test' }),
    toolResult('c1', false),
    ...Array.from({ length: 8 }, (_, i) => toolCall(`w${i}`, 'write', { path: `file-${i}.js` })),
  ])
  const handoff = composeHandoff(state, CONFIG)
  assert.ok(handoff.words <= 400, `words=${handoff.words}`)

  const tight = composeHandoff(state, normalizeConfig({ handoffMaxWords: 40 }))
  assert.ok(tight.words <= 40, `words=${tight.words}`)
  assert.match(tight.markdown, /…$/)
})

test('the wire view carries the flags and thresholds the client reads', () => {
  const view = viewOf(emptyState(), normalizeConfig({ meter: false, amber: 0.6 }))
  assert.equal(view.flags.meter, false)
  assert.equal(view.flags.templates, true)
  assert.equal(view.thresholds.amber, 0.6)
  assert.equal(view.handoff.words > 0, true)
})

test('unknown events are ignored without changing the state reference', () => {
  const state = emptyState()
  assert.equal(applyEvent(state, { type: 'something/else', data: {} }, CONFIG), state)
  assert.equal(applyEvent(state, null, CONFIG), state)
  assert.equal(applyEvent(state, {}, CONFIG), state)
})
