// End-to-end Host half: a fake Cordis context captures what the plugin registers,
// then drives the projection, the slash commands and the local handoff route.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { PROJECTION_KEY } from '../lib/core.js'

const CWD = await mkdtemp(join(tmpdir(), 'dsh-coach-'))

function fakeContext() {
  const registry = { projection: null, commands: new Map(), route: null, logger: [] }
  const ctx = {
    logger: {
      info: message => registry.logger.push(['info', message]),
      warn: message => registry.logger.push(['warn', message]),
    },
    effect(callback) {
      callback()
      return () => {}
    },
    inject(names, callback) {
      const child = {
        sessionProjections: {
          register(definition) {
            registry.projection = definition
            return Promise.resolve({
              stateOf: () => foldFrom(definition, registry.events ?? []),
              dispose: async () => {},
            })
          },
        },
        commands: {
          register(definition) {
            registry.commands.set(definition.name, definition)
            return () => {}
          },
        },
        connection: {
          fetch: {
            register(spec) {
              registry.route = spec
              return () => {}
            },
          },
        },
        agents: { get: id => (registry.session?.id === id ? { session: registry.session } : undefined) },
        effect(callback) {
          callback()
          return () => {}
        },
      }
      void names
      callback(child)
    },
  }
  return { ctx, registry }
}

function foldFrom(definition, events) {
  let state = definition.init({ id: 'session-test', cwd: CWD }, 0)
  for (const event of events) state = definition.apply(state, event)
  return state
}

function sessionEvents() {
  return [
    {
      type: 'request/context',
      data: { provider: 'deepseek', model: 'deepseek-flash', contextWindow: 200000 },
    },
    {
      type: 'request/header',
      data: {
        header: {
          config: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'medium', maxTokens: 65536 },
          tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }],
        },
        reason: 'initial',
      },
    },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Add the coach handoff command so long sessions can be closed cleanly.' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'I decided to derive the handoff from the projection rather than replaying the log.' }] }, usage: { inputTokens: 90000, outputTokens: 1500 } } },
    { type: 'tool/call', data: { callId: 'c1', name: 'write', arguments: JSON.stringify({ path: 'lib/index.js' }) } },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1' } } },
    { type: 'tool/call', data: { callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: 'package.json' }) } },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c2' } } },
    { type: 'tool/call', data: { callId: 'c3', name: 'pwsh', arguments: JSON.stringify({ command: 'node --test test/core.test.mjs' }) } },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c3' } } },
    { type: 'tool/call', data: { callId: 'c4', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'write the README', status: 'pending' }] }) } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'All tests passed, exit 0.' }] }, usage: { inputTokens: 96000, outputTokens: 800 } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('the host half wires one projection, two commands and one route', async () => {
  const { ctx, registry } = fakeContext()
  apply(ctx, {})
  registry.events = sessionEvents()
  registry.session = { id: 'session-test', header: { id: 'session-test', cwd: CWD } }
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(registry.projection.key, PROJECTION_KEY)
  assert.equal(registry.projection.stateVersion, 1)
  assert.ok(registry.commands.has('handoff'))
  assert.ok(registry.commands.has('coach'))
  assert.equal(registry.route.path, '/api/dsh-coach/handoff')

  // The client view is a plain JSON value, small enough to push per event.
  const view = registry.projection.wire.view(foldFrom(registry.projection, registry.events))
  assert.equal(view.context.compactionAt, 68928)
  assert.ok(view.context.ratio > 0.9)
  assert.equal(view.done, true)
  assert.deepEqual(view.flags.templates, true)
  assert.ok(JSON.stringify(view).length < 8000)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(view)))

  // /coach reports the thresholds without touching a model.
  const coach = await registry.commands.get('coach').handler({
    agent: { session: registry.session },
    rawInput: '',
    commandId: 'cmd-1',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(coach.kind, 'success')
  assert.match(coach.text, /Context: 140% of 68928 tokens/)
  assert.match(coach.text, /amber 70%, red 90%/)
  assert.match(coach.text, /- meter: on/)

  // /coach --off meter is session-scoped and shows up in the next view.
  const off = await registry.commands.get('coach').handler({
    agent: { session: registry.session },
    rawInput: ' --off meter',
    commandId: 'cmd-2',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(off.kind, 'success')
  assert.match(off.text, /meter is off/)

  // /handoff writes the file next to the session cwd.
  const handoff = await registry.commands.get('handoff').handler({
    agent: { session: registry.session },
    rawInput: '',
    commandId: 'cmd-3',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(handoff.kind, 'success', handoff.text)
  assert.match(handoff.text, /Handoff written to/)
  assert.match(handoff.text, /words\)/)

  const directory = join(CWD, '.dsh')
  const files = await readdir(directory)
  assert.equal(files.length, 1)
  assert.match(files[0], /^handoff-\d{8}-\d{4}\.md$/)
  const written = await readFile(join(directory, files[0]), 'utf8')
  const words = written.trim().split(/\s+/).length
  assert.ok(words <= 400, `words=${words}`)
  assert.match(written, /## Objective/)
  assert.match(written, /lib\/index\.js/)
  assert.match(written, /package\.json/)
  assert.match(written, /## Verification/)
  assert.match(written, /## Open items/)
  assert.match(written, /write the README/)
  // The projection never records a prompt section: the file holds no system text.
  assert.doesNotMatch(written, /You are a coding agent/)
})

test('the handoff route answers JSON and refuses unknown sessions', async () => {
  const { ctx, registry } = fakeContext()
  apply(ctx, {})
  registry.events = sessionEvents()
  registry.session = { id: 'session-test', header: { id: 'session-test', cwd: CWD } }
  await Promise.resolve()
  await Promise.resolve()

  const call = async payload => {
    const request = new Request('http://127.0.0.1:3080/api/dsh-coach/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const response = await registry.route.fetch(request)
    return { status: response.status, body: await response.json() }
  }

  const ok = await call({ sessionId: 'session-test' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.match(ok.body.value.path, /handoff-\d{8}-\d{4}\.md$/)
  assert.ok(ok.body.value.words > 0)

  const missing = await call({})
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'argument')

  const unknown = await call({ sessionId: 'session-nope' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'unknown-session')
})

test('cleanup', async () => {
  await rm(CWD, { recursive: true, force: true })
})
