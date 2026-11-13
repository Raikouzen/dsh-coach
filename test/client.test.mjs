// Loads the browser half in Node with a stubbed module loader, then exercises the
// pure helpers it ships (draft meter, topic-change heuristic, done detection).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

let host = null

async function loadClient() {
  if (host !== null) return host
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let definition = null
  globalThis.window = {
    __ModuleLoader__: {
      load(candidate) {
        definition = candidate
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function(source)()
  assert.ok(definition !== null, 'client half did not call __ModuleLoader__.load')
  const fakeReact = { createElement: () => null, useState: value => [value, () => {}], useEffect: () => {} }
  host = definition.factory(() => fakeReact)
  delete globalThis.window
  return host
}

test('meter fixtures score exactly as documented', async () => {
  const client = await loadClient()
  const { scorePrompt } = client.__test

  assert.equal(scorePrompt('').suppressed, true)
  assert.equal(scorePrompt('   ').suppressed, true)
  assert.equal(scorePrompt('/compact now please').suppressed, true)

  // Bare request: a deliverable but nothing that bounds it.
  const bare = scorePrompt('fix the bug')
  assert.equal(bare.score, 1)
  assert.deepEqual(bare.missing, ['deliverable', 'acceptance', 'constraints', 'stop'])
  assert.equal(bare.checks[0].ok, false, 'no artifact is named')

  // A tight prompt hits every check.
  const tight = scorePrompt(
    [
      'Deliverable: lib/coach.js — add the handoff command.',
      'Must: keep it under 200 lines; never touch the system prompt.',
      'Done when: node --test test/core.test.mjs passes and prints exit 0.',
      'Stop when: the tests pass; then stop.',
      'Context: the projection already holds the ingredients.',
    ].join('\n'),
  )
  assert.equal(tight.score, 5, JSON.stringify(tight.checks))
  assert.deepEqual(tight.missing, [])

  // The anti-pattern costs the size point and nothing else.
  const rambling = scorePrompt(
    [
      'Deliverable: write a script that renames photos.',
      'Done when: the file list is correct.',
      'Must: never delete a file; keep it under 50 lines.',
      'Stop when: the list is printed; then stop.',
      'Be thorough and do not stop until it is perfect.',
    ].join('\n'),
  )
  assert.equal(rambling.score, 4, JSON.stringify(rambling.missing))
  assert.deepEqual(rambling.missing, ['compact'])

  // Oversized drafts lose the size point too.
  const oversized = scorePrompt(
    ['Deliverable: build the thing.', 'Done when: it works.', 'Stop when: it works; then stop.', 'Must: never fail.', 'x '.repeat(700)].join('\n'),
  )
  assert.ok(oversized.missing.includes('compact'))
})

test('topic-change fixtures: five follow-ups stay quiet, three switches fire', async () => {
  const client = await loadClient()
  const { topicSwitch, jaccard } = client.__test

  assert.equal(jaccard(['composer', 'slot'], ['composer', 'slot']), 1)
  assert.equal(jaccard(['a', 'b'], ['c', 'd']), 0)

  const history = [
    'the composer slot registration shape still needs verifying',
    'composer slot registration: does the entry id have to be unique per plugin',
    'ok so the slot registration is fine, but what about the projection key',
  ]
  const followUps = [
    'and the slot registration for the composer, is the order field required',
    'one more question on the composer slot registration and the projection key naming',
    'does the projection key have to be unique across plugins, or can two plugins share it',
    'if two plugins share the projection key, does the slot registration order matter',
    'final check: the composer slot registration plus the projection key are both fine',
  ]
  for (const draft of followUps) {
    assert.equal(topicSwitch(draft, history), false, draft)
  }

  const switches = [
    'write a python script that renames every photo by its exif creation date',
    'book a flight to tokyo for the second week of december and compare prices',
    'explain how sourdough starter hydration percentages affect crumb texture',
  ]
  for (const draft of switches) {
    assert.equal(topicSwitch(draft, history), true, draft)
  }

  // Short drafts never trigger, however unrelated.
  assert.equal(topicSwitch('write a python script', history), false)
  // An explicit marker does.
  assert.equal(topicSwitch('new task: ship the release notes', history), true)
})

test('done detection reads the reply, not the turn', async () => {
  const client = await loadClient()
  const { looksDone } = client.__test
  assert.equal(looksDone('All tests passed, exit 0.'), true)
  assert.equal(looksDone('✓ verified'), true)
  assert.equal(looksDone('I still need one detail.'), false)
})

test('templates are six-line skeletons and every missing check has an add line', async () => {
  const client = await loadClient()
  const { TEMPLATES, CHECKS, scorePrompt } = client.__test
  assert.equal(TEMPLATES.length, 3)
  for (const template of TEMPLATES) {
    assert.equal(template.text.split('\n').length, 6, template.key)
    const scored = scorePrompt(template.text)
    // A template is a skeleton with `<placeholders>`: it must read as a real
    // deliverable-shaped prompt rather than an empty one.
    assert.equal(scored.suppressed, false)
    assert.ok(scored.score >= 3, `${template.key} scored ${scored.score}`)
  }
  for (const check of CHECKS) {
    if (check.key === 'compact') {
      assert.equal(check.line, '')
      continue
    }
    assert.ok(check.line.length > 0, check.key)
    // The add line only appends: it never carries a rewording of the draft.
    assert.ok(!check.line.includes('\n'), check.key)
  }
})

test('the freshness chip only appears on a real signal', async () => {
  const client = await loadClient()
  const { coachReason } = client.__test
  const base = {
    flags: { nudge: true, drift: true },
    thresholds: { amber: 0.7, red: 0.9 },
    drift: { changed: false, line: '' },
    context: { ratio: 0.2, compactionAt: 68928, pressure: 13000 },
    turns: 4,
    done: false,
    users: ['something about slots'],
  }
  const sessionId = 'session-test'

  assert.equal(coachReason(base, 'a short note', sessionId), null)
  assert.equal(coachReason({ ...base, flags: { nudge: false } }, '', sessionId), null)

  // Context pressure at the red line always shows.
  const hot = { ...base, context: { ratio: 0.93, compactionAt: 68928, pressure: 64000 } }
  assert.equal(coachReason(hot, '', sessionId).tone, 'context')

  // Drift outranks everything.
  const drifting = { ...hot, drift: { changed: true, line: 'model flash→pro' } }
  assert.equal(coachReason(drifting, '', sessionId).tone, 'drift')
  assert.match(coachReason(drifting, '', sessionId).copy, /flash→pro/)

  // A finished turn at amber.
  const finished = { ...base, done: true, context: { ratio: 0.75, compactionAt: 68928, pressure: 51000 } }
  assert.equal(coachReason(finished, '', sessionId).tone, 'done')
  assert.equal(coachReason({ ...finished, context: { ratio: 0.4 } }, '', sessionId), null)

  // A new-task-shaped draft.
  const switched = coachReason(base, 'write a python script that renames every photo by its exif date', sessionId)
  assert.equal(switched.tone, 'topic')

  // A session with no earlier ask cannot be having a topic change: the first
  // message of a session is never nagged about.
  const fresh = { ...base, users: [], turns: 0 }
  assert.equal(coachReason(fresh, 'write a python script that renames every photo by its exif date', sessionId), null)

  // Dismissal is scoped to two turns.
  client.__test.dismiss(sessionId, 5)
  assert.equal(coachReason({ ...hot, turns: 5 }, '', sessionId), null)
  assert.equal(coachReason({ ...hot, turns: 6 }, '', sessionId).tone, 'context')
  client.__test.clearDismissals()
})
