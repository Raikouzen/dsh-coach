// dsh-coach — host half.
//
// Zero DSH imports on purpose (the dsh-incognito pattern): the bundle loads from
// a plain directory install, where `@deepseek-ai/*` packages are not resolvable.
// Everything the host needs arrives through injected services:
//
//   sessionProjections — the `coachSetup` fold: setup drift, context pressure,
//                        and the ingredients of a handoff document.
//   commands           — `/handoff` (write the file, deterministic) and
//                        `/coach` (thresholds, toggles).
//   connection         — one local route the composer chip posts to, so a click
//                        writes the handoff file before the new session opens.
//   agents             — resolve a session id from that route.
//
// Cache neutrality: no prompt sections, no context blocks, no tool registration.
// The system prompt is byte-identical with the plugin installed.

import fsp from 'node:fs/promises'
import { join } from 'node:path'

import {
  PROJECTION_KEY,
  composeHandoff,
  driftLine,
  driftOf,
  handoffFileName,
  normalizeConfig,
  projectionDefinition,
  viewOf,
} from './core.js'

export const name = 'dsh-coach'

/** No hard dependency: every service is read through `ctx.inject`, so a lean
 * deployment still activates the half it can support. */
export const inject = []

const ROUTE = '/api/dsh-coach/handoff'
const FEATURE_NAMES = new Set(['meter', 'templates', 'nudge', 'drift'])

/** Sessions whose features the user switched off with `/coach --off`. */
const switchedOff = new Map()

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function bodyOf(request) {
  try {
    const body = await request.json()
    return body !== null && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function isOff(sessionId, feature) {
  const set = switchedOff.get(sessionId)
  return set === undefined ? false : set.has(feature)
}

/** Resolve the target directory for a handoff file. */
function handoffDirectory(session, config) {
  const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
  return cwd === '' ? null : join(cwd, config.handoffDir)
}

/** Write one handoff document and return its absolute path. */
async function writeHandoff(session, config, markdown) {
  const directory = handoffDirectory(session, config)
  if (directory === null) {
    throw new Error('this session has no working directory; nothing to write next to')
  }
  await fsp.mkdir(directory, { recursive: true })
  const path = join(directory, handoffFileName())
  await fsp.writeFile(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8')
  return path
}

/** Percentage of the compaction trigger a session has consumed. */
function percentText(context) {
  if (context.ratio === null) return 'unknown'
  return `${Math.round(context.ratio * 100)}% of ${Math.round(context.compactionAt ?? 0)} tokens`
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  /** Retained projection handle: folds a cold session on demand for commands. */
  let handle
  let handleError

  // ── H1: the coachSetup projection ────────────────────────────────────────────
  ctx.inject(['sessionProjections'], child => {
    Promise.resolve(child.sessionProjections.register(projectionDefinition(config)))
      .then(registered => {
        handle = registered
      })
      .catch(error => {
        handleError = errorText(error)
        ctx.logger?.warn?.(`[dsh-coach] projection registration failed: ${handleError}`)
      })
  })

  /** Read the live view for one session, folding any unobserved events. */
  function viewFor(session) {
    if (session === undefined || session === null) return null
    if (handle === undefined) return null
    try {
      const state = handle.stateOf(session)
      const view = viewOf(state, config)
      const id = session.id
      const off = []
      for (const feature of FEATURE_NAMES) if (isOff(id, feature)) off.push(feature)
      if (off.length > 0) {
        view.flags = { ...view.flags }
        for (const feature of off) view.flags[feature] = false
      }
      return { view, state }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-coach] projection read failed: ${errorText(error)}`)
      return null
    }
  }

  // ── H2/H3: slash commands ────────────────────────────────────────────────────
  ctx.inject(['commands'], child => {
    child.commands.register({
      name: 'handoff',
      description: 'Write a handoff document for this session into the workspace .dsh directory.',
      handler: async invocation => {
        const session = invocation?.agent?.session
        const read = viewFor(session)
        if (read === null) {
          return {
            kind: 'error',
            text: 'dsh-coach: no coach projection is live for this session yet — send one message first.',
          }
        }
        try {
          const path = await writeHandoff(session, config, read.view.handoff.markdown)
          const header = `Handoff written to ${path} (${read.view.handoff.words} words).`
          return { kind: 'success', text: `${header}\n\n${read.view.handoff.markdown}` }
        } catch (error) {
          return { kind: 'error', text: `dsh-coach: ${errorText(error)}` }
        }
      },
    })

    child.commands.register({
      name: 'coach',
      description: 'Show the coach thresholds and feature toggles for this session.',
      handler: async invocation => {
        const session = invocation?.agent?.session
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
        const match = raw.match(/^--(off|on)\s+(\S+)/i)
        if (match !== null) {
          const feature = match[2].toLowerCase()
          if (!FEATURE_NAMES.has(feature)) {
            return {
              kind: 'error',
              text: `dsh-coach: unknown feature "${feature}". Known: ${[...FEATURE_NAMES].join(', ')}.`,
            }
          }
          const id = session?.id
          if (id === undefined) return { kind: 'error', text: 'dsh-coach: no session.' }
          const set = switchedOff.get(id) ?? new Set()
          if (match[1].toLowerCase() === 'off') set.add(feature)
          else set.delete(feature)
          if (set.size === 0) switchedOff.delete(id)
          else switchedOff.set(id, set)
          const state = match[1].toLowerCase() === 'off' ? 'off' : 'on'
          return { kind: 'success', text: `dsh-coach: ${feature} is ${state} for this session.` }
        }
        const read = viewFor(session)
        const lines = ['**dsh-coach**', '']
        if (read === null) {
          lines.push('No coach projection is live for this session yet.')
        } else {
          const { view } = read
          lines.push(`Context: ${percentText(view.context)}` +
            (view.context.pressure === null ? '' : ` (${Math.round(view.context.pressure)} tokens estimated)`))
          lines.push(`Thresholds: amber ${Math.round(config.amber * 100)}%, red ${Math.round(config.red * 100)}% of the compaction trigger.`)
          lines.push(`Compaction: min(${Math.round(config.compactionRatio * 100)}% of window, window − completion − ${config.headroomTokens}).`)
          lines.push(`Handoff: ${view.handoff.words} words, ${view.handoff.files} files, ${view.handoff.decisions} decisions, ${view.handoff.open} open items → \`${config.handoffDir}/\``)
          const drift = driftOf(view.initial, view.current)
          lines.push(`Setup: ${drift.changed ? driftLine(drift) : 'unchanged since the first request'}.`)
          lines.push('')
          for (const feature of FEATURE_NAMES) {
            const enabled = config[feature] === true && !isOff(session?.id, feature)
            lines.push(`- ${feature}: ${enabled ? 'on' : 'off'}`)
          }
          lines.push('', 'Toggle one for this session: `/coach --off meter`, `/coach --on meter`.')
        }
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })

  // ── The one local route: write the handoff file ──────────────────────────────
  ctx.inject(['connection', 'agents'], child => {
    const disposers = []
    const dispose = child.connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        const body = await bodyOf(request)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return json({ ok: false, error: { code: 'argument', message: 'sessionId is required' } }, 400)
        const agent = child.agents.get(sessionId)
        const session = agent?.session
        if (session === undefined) {
          return json({ ok: false, error: { code: 'unknown-session', message: 'that session is not live on this host' } }, 404)
        }
        const read = viewFor(session)
        if (read === null) {
          return json({ ok: false, error: { code: 'warmup', message: 'the coach projection is not ready yet' } })
        }
        try {
          const path = await writeHandoff(session, config, read.view.handoff.markdown)
          return json({ ok: true, value: { path, words: read.view.handoff.words } })
        } catch (error) {
          return json({ ok: false, error: { code: 'write', message: errorText(error) } })
        }
      },
    })
    disposers.push(dispose)
    child.effect(() => () => {
      for (const entry of disposers.splice(0)) {
        try {
          void entry()
        } catch {
          /* already gone */
        }
      }
    }, 'dsh-coach.routes')
  })

  ctx.effect(() => () => switchedOff.clear(), 'dsh-coach.state')
}

/** Re-exported for the tests and for anyone reading the projection from outside. */
export { PROJECTION_KEY, composeHandoff }
