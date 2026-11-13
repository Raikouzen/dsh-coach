// dsh-coach — pure host helpers.
//
// No DSH imports and no side effects: this module is loadable by plain Node so
// the fold, the compaction arithmetic and the handoff composition can be tested
// without booting a harness.

/** Config defaults; every field is overridable from the bundle patch. */
export const DEFAULT_CONFIG = {
  meter: true,
  templates: true,
  nudge: true,
  drift: true,
  amber: 0.7,
  red: 0.9,
  compactionRatio: 0.8,
  headroomTokens: 65536,
  handoffDir: '.dsh',
  handoffMaxWords: 400,
}

/** Bumped whenever the persisted fold shape changes in an incompatible way. */
export const STATE_VERSION = 1

/** Projection key shared by the host unit and the client `useProjection` read. */
export const PROJECTION_KEY = 'coachSetup'

const MAX_USERS = 3
const MAX_DECISIONS = 6
const MAX_FILES = 12
const MAX_COMMANDS = 3
const MAX_OPEN = 8
const MAX_CALLS = 24
const MAX_LINE = 200

const WRITE_TOOLS = /^(write|edit|apply_patch|multi_edit|str_replace|str_replace_editor|create_file|notebook_edit)$/i
const SHELL_TOOLS = /^(pwsh|pwsh_tool|bash|win_bash|shell|run_command)$/i
const TODO_TOOLS = /^(todo_write|todo|todowrite)$/i
const DONE_TEXT = /\b(passed|all tests|exit 0|verified|verified it|green)\b|✓/i
const DECISION_TEXT = /\b(decided|chose|chosen|rather than|instead of|settled on)\b/i
const HANDOFF_FILENAME = /^handoff-\d{8}-\d{4}\.md$/

const asString = value => (typeof value === 'string' ? value : '')
const asNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const asBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/** Coerce one raw config row into a complete, valid config. */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const ratio = asNumber(source.compactionRatio)
  const amber = asNumber(source.amber)
  const red = asNumber(source.red)
  const headroomTokens = asNumber(source.headroomTokens)
  const maxWords = asNumber(source.handoffMaxWords)
  return {
    meter: asBool(source.meter, DEFAULT_CONFIG.meter),
    templates: asBool(source.templates, DEFAULT_CONFIG.templates),
    nudge: asBool(source.nudge, DEFAULT_CONFIG.nudge),
    drift: asBool(source.drift, DEFAULT_CONFIG.drift),
    amber: amber !== null && amber > 0 && amber < 1 ? amber : DEFAULT_CONFIG.amber,
    red: red !== null && red > 0 && red <= 1 ? red : DEFAULT_CONFIG.red,
    compactionRatio:
      ratio !== null && ratio > 0 && ratio <= 1 ? ratio : DEFAULT_CONFIG.compactionRatio,
    headroomTokens:
      headroomTokens !== null && headroomTokens >= 0
        ? Math.floor(headroomTokens)
        : DEFAULT_CONFIG.headroomTokens,
    handoffDir:
      typeof source.handoffDir === 'string' && source.handoffDir.trim() !== ''
        ? source.handoffDir.trim()
        : DEFAULT_CONFIG.handoffDir,
    handoffMaxWords:
      maxWords !== null && maxWords > 0 ? Math.floor(maxWords) : DEFAULT_CONFIG.handoffMaxWords,
  }
}

/**
 * The pressure at which `dsh-compaction-basic` compacts, mirrored exactly:
 * `floor(min(ratio * window, window - reservedCompletionTokens - headroomTokens))`.
 * An unknown completion reservation defaults to the headroom, as the engine's
 * own default does; a collapsing budget falls back to the ratio bound instead of
 * throwing, because the coach is advisory and must never break a session.
 */
export function compactionTrigger(contextWindow, reservedTokens, config = DEFAULT_CONFIG) {
  const window = asNumber(contextWindow)
  if (window === null || window <= 0) return null
  const ratioBound = window * (config.compactionRatio ?? DEFAULT_CONFIG.compactionRatio)
  const headroom = config.headroomTokens ?? DEFAULT_CONFIG.headroomTokens
  const reserved = asNumber(reservedTokens) ?? headroom
  const budget = window - reserved - headroom
  const bound = budget > 0 ? Math.min(ratioBound, budget) : ratioBound
  return Math.max(1, Math.floor(bound))
}

/** Concatenated text blocks of one message-shaped value. */
export function textOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out += (out === '' ? '' : '\n') + block.text
    }
  }
  return out
}

/** One normalized, length-capped line for a heading or bullet. */
export function firstLine(text, limit = MAX_LINE) {
  const raw = asString(text).replace(/\s+/g, ' ').trim()
  if (raw === '') return ''
  return raw.length <= limit ? raw : raw.slice(0, limit - 1).trimEnd() + '…'
}

function safeJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function uniquePush(list, value) {
  if (typeof value !== 'string') return list
  const item = value.trim()
  if (item === '') return list
  if (list.includes(item)) return list
  return [...list, item]
}

function tail(list, limit) {
  return list.length <= limit ? list : list.slice(list.length - limit)
}

function fileFromArguments(args) {
  if (args === null) return null
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  const patch = asString(args.patch) || asString(args.input) || asString(args.diff)
  if (patch !== '') {
    const match = patch.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)
    if (match !== null) return match[1].trim()
  }
  return null
}

function todosFromArguments(args) {
  if (args === null) return []
  const list = Array.isArray(args.todos) ? args.todos : Array.isArray(args.items) ? args.items : null
  if (list === null) return []
  const open = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const status = asString(entry.status).toLowerCase()
    if (status === 'completed' || status === 'done' || status === 'cancelled') continue
    const content = firstLine(asString(entry.content) || asString(entry.text), 160)
    if (content !== '') open.push(content)
  }
  return open
}

/** Blank fold state for one session. Total: every field has a safe default. */
export function emptyState() {
  return {
    version: STATE_VERSION,
    initial: null,
    current: null,
    window: null,
    reserved: null,
    pressure: null,
    turns: 0,
    done: false,
    first: '',
    users: [],
    decisions: [],
    files: [],
    commands: [],
    open: [],
    calls: [],
    lastText: '',
  }
}

function setupOf(header) {
  const config = header !== null && typeof header === 'object' ? header.config : null
  const provider = asString(config?.provider)
  const model = asString(config?.model)
  const effort = asString(config?.reasoningEffort)
  const tools = Array.isArray(header?.tools)
    ? header.tools.map(tool => asString(tool?.name)).filter(name => name !== '')
    : []
  return {
    model: model === '' ? null : provider === '' ? model : `${provider}/${model}`,
    effort: effort === '' ? null : effort,
    tools,
  }
}

/**
 * Total normalization of a persisted fold state. `sessionProjections.restore`
 * parses a stored checkpoint without a guard, so this must never throw: an
 * unreadable value degrades to a blank state rather than breaking the session.
 */
export function normalizeState(value) {
  const base = emptyState()
  if (value === null || typeof value !== 'object') return base
  const setup = candidate => {
    if (candidate === null || typeof candidate !== 'object') return null
    return {
      model: typeof candidate.model === 'string' ? candidate.model : null,
      effort: typeof candidate.effort === 'string' ? candidate.effort : null,
      tools: Array.isArray(candidate.tools)
        ? tail(candidate.tools.filter(tool => typeof tool === 'string'), 400)
        : [],
    }
  }
  const strings = (list, limit) =>
    Array.isArray(list) ? tail(list.filter(item => typeof item === 'string'), limit) : []
  return {
    version: STATE_VERSION,
    initial: setup(value.initial),
    current: setup(value.current),
    window: asNumber(value.window),
    reserved: asNumber(value.reserved),
    pressure: asNumber(value.pressure),
    turns: asNumber(value.turns) ?? 0,
    done: value.done === true,
    first: asString(value.first).slice(0, MAX_LINE),
    users: strings(value.users, MAX_USERS),
    decisions: strings(value.decisions, MAX_DECISIONS),
    files: strings(value.files, MAX_FILES),
    commands: Array.isArray(value.commands)
      ? tail(
          value.commands
            .filter(entry => entry !== null && typeof entry === 'object')
            .map(entry => ({ command: firstLine(entry.command, 120), ok: entry.ok === true })),
          MAX_COMMANDS,
        )
      : [],
    open: strings(value.open, MAX_OPEN),
    calls: Array.isArray(value.calls)
      ? tail(
          value.calls
            .filter(entry => Array.isArray(entry) && typeof entry[0] === 'string')
            .map(entry => [entry[0], asString(entry[1]), firstLine(entry[2], 120)]),
          MAX_CALLS,
        )
      : [],
    lastText: asString(value.lastText).slice(-1200),
  }
}

/** Schema handed to the projection unit; only `parse` is used by the registry. */
export const stateSchema = {
  parse: value => normalizeState(value),
}

/** Client-visible schema. The view is already plain JSON by construction. */
export const viewSchema = {
  parse: value => (value !== null && typeof value === 'object' ? value : null),
}

/** Model / effort / tool set changed since the session opened. */
export function driftOf(initial, current) {
  if (initial === null || current === null) return { changed: false }
  const modelChanged = initial.model !== current.model
  const effortChanged = initial.effort !== current.effort
  const initialTools = new Set(initial.tools)
  const currentTools = new Set(current.tools)
  const toolsAdded = current.tools.filter(name => !initialTools.has(name))
  const toolsRemoved = initial.tools.filter(name => !currentTools.has(name))
  return {
    changed: modelChanged || effortChanged || toolsAdded.length > 0 || toolsRemoved.length > 0,
    model: modelChanged ? { from: initial.model, to: current.model } : null,
    effort: effortChanged ? { from: initial.effort, to: current.effort } : null,
    toolsAdded,
    toolsRemoved,
  }
}

/** One-line, human phrasing of a drift finding. */
export function driftLine(drift) {
  if (drift === null || drift.changed !== true) return ''
  const parts = []
  if (drift.model !== null) parts.push(`model ${shortName(drift.model.from)}→${shortName(drift.model.to)}`)
  if (drift.effort !== null) parts.push(`effort ${drift.effort.from ?? 'default'}→${drift.effort.to ?? 'default'}`)
  if (drift.toolsAdded.length > 0) parts.push(`tools +${drift.toolsAdded.length} (${drift.toolsAdded.slice(0, 3).join(', ')}${drift.toolsAdded.length > 3 ? '…' : ''})`)
  if (drift.toolsRemoved.length > 0) parts.push(`tools −${drift.toolsRemoved.length} (${drift.toolsRemoved.slice(0, 3).join(', ')}${drift.toolsRemoved.length > 3 ? '…' : ''})`)
  return parts.join(' · ')
}

/** Last path segment of a `provider/model` id, for compact copy. */
export function shortName(id) {
  const text = asString(id)
  if (text === '') return 'default'
  const slash = text.lastIndexOf('/')
  return slash === -1 ? text : text.slice(slash + 1)
}

/** Fold one session event into the coach state. Pure and total. */
export function applyEvent(state, event, config = DEFAULT_CONFIG) {
  const type = asString(event?.type)
  const data = event !== null && typeof event === 'object' ? event.data : undefined
  switch (type) {
    case 'request/header': {
      const header = data?.header
      const setup = setupOf(header)
      if (setup.model === null && setup.effort === null && setup.tools.length === 0) return state
      const reserved = asNumber(header?.config?.maxTokens)
      return {
        ...state,
        initial: state.initial ?? setup,
        current: setup,
        reserved: reserved ?? state.reserved,
      }
    }
    case 'request/context': {
      const window = asNumber(data?.contextWindow)
      if (window === null) return state
      return { ...state, window }
    }
    case 'assistant/message': {
      const text = textOf(data?.message)
      const usage = data?.usage
      const input = asNumber(usage?.inputTokens)
      const output = asNumber(usage?.outputTokens)
      const cacheRead = asNumber(usage?.cacheReadTokens)
      let pressure = state.pressure
      if (input !== null) pressure = input + (output ?? 0) + (cacheRead ?? 0)
      let decisions = state.decisions
      if (text !== '') {
        for (const sentence of text.split(/(?<=[.!?。！？])\s+|\n+/)) {
          if (!DECISION_TEXT.test(sentence)) continue
          const line = firstLine(sentence, 160)
          if (line === '') continue
          decisions = uniquePush(decisions, line)
          if (decisions.length > MAX_DECISIONS) decisions = decisions.slice(-MAX_DECISIONS)
        }
      }
      return {
        ...state,
        pressure,
        decisions,
        lastText: text === '' ? state.lastText : text.slice(-1200),
      }
    }
    case 'user/message': {
      const line = firstLine(textOf(data), MAX_LINE)
      if (line === '') return state
      return {
        ...state,
        first: state.first === '' ? line : state.first,
        users: tail([...state.users, line], MAX_USERS),
      }
    }
    case 'tool/call': {
      const name = asString(data?.name)
      const callId = asString(data?.callId)
      let next = state
      if (callId !== '') {
        const command = SHELL_TOOLS.test(name)
          ? firstLine(safeJson(data?.arguments)?.command ?? safeJson(data?.arguments)?.cmd ?? '', 120)
          : ''
        next = { ...next, calls: tail([...next.calls, [callId, name, command]], MAX_CALLS) }
      }
      if (WRITE_TOOLS.test(name)) {
        const file = fileFromArguments(safeJson(data?.arguments))
        if (file !== null) next = { ...next, files: tail(uniquePush(next.files, file), MAX_FILES) }
      } else if (TODO_TOOLS.test(name)) {
        const open = todosFromArguments(safeJson(data?.arguments))
        next = { ...next, open: tail(open, MAX_OPEN) }
      }
      return next
    }
    case 'tool/result': {
      const callId = asString(data?.message?.toolCallId) || asString(data?.toolCallId)
      const call = lookupCall(state.calls, callId)
      if (!SHELL_TOOLS.test(call.name)) return state
      const ok = data?.error === undefined && data?.message?.isError !== true
      return {
        ...state,
        commands: tail([...state.commands, { command: call.command, ok }], MAX_COMMANDS),
      }
    }
    case 'turn/end': {
      const kind = asString(data?.reason?.kind)
      const done = kind === 'completed' && DONE_TEXT.test(state.lastText)
      return { ...state, turns: state.turns + 1, done }
    }
    default:
      return state
  }
}

function lookupCall(calls, callId) {
  if (callId === '') return { name: '', command: '' }
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i][0] === callId) return { name: asString(calls[i][1]), command: asString(calls[i][2]) }
  }
  return { name: '', command: '' }
}

/**
 * Compose the handoff document. Deterministic and capped at
 * `config.handoffMaxWords`, so the same session always yields the same text.
 */
export function composeHandoff(state, config = DEFAULT_CONFIG, now = Date.now()) {
  const drift = driftOf(state.initial, state.current)
  const sections = []
  const objective = state.first === '' ? '' : state.first
  const header = [`# Handoff — ${stamp(now)}`, '']
  sections.push('## Objective', objective === '' ? '- (no user message captured)' : objective, '')
  if (state.decisions.length > 0) {
    sections.push('## Decisions', ...state.decisions.map(line => `- ${line}`), '')
  }
  if (state.files.length > 0) {
    sections.push('## Files touched', ...state.files.map(file => `- ${file}`), '')
  }
  if (state.commands.length > 0) {
    sections.push(
      '## Verification',
      ...state.commands.map(entry => `- \`${entry.command || '(no text)'}\` → ${entry.ok ? 'ok' : 'failed'}`),
      '',
    )
  }
  if (state.open.length > 0) {
    sections.push('## Open items', ...state.open.map(item => `- ${item}`), '')
  }
  if (drift.changed) {
    sections.push('## Setup changed mid-session', `- ${driftLine(drift)}`, '')
  }
  const body = sections.join('\n')
  const budget = config.handoffMaxWords ?? DEFAULT_CONFIG.handoffMaxWords
  const words = countWords(header.join('\n') + body)
  const cut = words > budget ? trimToWords(header.join('\n') + body, budget) : header.join('\n') + body
  return {
    markdown: cut,
    words: countWords(cut),
    objective,
    files: state.files.length,
    decisions: state.decisions.length,
    open: state.open.length,
  }
}

function countWords(text) {
  const trimmed = asString(text).trim()
  if (trimmed === '') return 0
  return trimmed.split(/\s+/).length
}

/** Cut whole trailing words, keeping a closing ellipsis. */
function trimToWords(text, budget) {
  const words = text.split(/\s+/)
  if (words.length <= budget) return text
  const kept = words.slice(0, Math.max(1, budget - 1))
  return `${kept.join(' ')} …`
}

/** `20261114-0144` in local time; the handoff file name uses the same stamp. */
export function stamp(now = Date.now()) {
  const date = new Date(now)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** Absolute-ish handoff file name inside the session's configured directory. */
export function handoffFileName(now = Date.now()) {
  return `handoff-${stamp(now)}.md`
}

/** Whether a file name is one this plugin wrote (never read or delete anything else). */
export function isHandoffFile(name) {
  return HANDOFF_FILENAME.test(asString(name))
}

/** The client-visible view of one fold state. Pure: same state, same view. */
export function viewOf(state, config = DEFAULT_CONFIG) {
  const normalized = normalizeState(state)
  const drift = driftOf(normalized.initial, normalized.current)
  const compactionAt = compactionTrigger(normalized.window, normalized.reserved, config)
  const pressure = normalized.pressure
  const ratio =
    compactionAt === null || pressure === null ? null : Math.min(1.5, pressure / compactionAt)
  const handoff = composeHandoff(normalized, config)
  return {
    version: STATE_VERSION,
    initial: normalized.initial,
    current: normalized.current,
    drift: { ...drift, line: driftLine(drift) },
    context: {
      pressure,
      window: normalized.window,
      compactionAt,
      ratio,
    },
    turns: normalized.turns,
    done: normalized.done,
    users: normalized.users,
    objective: normalized.first,
    handoff: {
      markdown: handoff.markdown,
      words: handoff.words,
      files: handoff.files,
      decisions: handoff.decisions,
      open: handoff.open,
    },
    thresholds: { amber: config.amber, red: config.red },
    flags: {
      meter: config.meter,
      templates: config.templates,
      nudge: config.nudge,
      drift: config.drift,
      handoffDir: config.handoffDir,
    },
  }
}

/** The projection unit handed to `sessionProjections.register`. */
export function projectionDefinition(config = DEFAULT_CONFIG) {
  const cached = { config }
  return {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: () => emptyState(),
    apply: (state, event) => applyEvent(state, event, cached.config),
    wire: {
      viewSchema,
      view: state => viewOf(state, cached.config),
      summary: false,
    },
  }
}
