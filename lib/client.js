// dsh-coach — client half.
//
// A browser half cannot import modules, so everything here is self-contained:
// the draft meter, the topic-change heuristic and the handoff copy are local
// pure functions. The only data that crosses the wire is the host's `coachSetup`
// projection (already composed on the host) and one local POST that writes the
// handoff file.
//
// Surfaces:
//   conversation.input.left           template inserter (Build / Fix / Investigate)
//   conversation.input.right          live draft meter (0-5 + one-line reasons)
//   conversation.input.overlay        freshness chip (handoff / new session / dismiss)
//   conversation.chat.turnTail        one-line nudge after a completed turn
//   conversation.session.header.corner setup-drift dot
//
// Nothing here sends a message, rewrites typed text or touches the system prompt.

;(function () {
  var PLUGIN = 'dsh-coach'
  var PROJECTION = 'coachSetup'
  var ROUTE = '/api/dsh-coach/handoff'
  var CSS_ID = PLUGIN + '.css'
  /** Bound once inside the module factory: `{ React, createElement }`. */
  var h = null

  // ── pure helpers (also exported for the Node tests) ─────────────────────────

  var STOPWORDS = {
    the: 1, a: 1, an: 1, and: 1, or: 1, but: 1, if: 1, then: 1, so: 1, to: 1, of: 1, in: 1,
    on: 1, for: 1, with: 1, is: 1, are: 1, was: 1, were: 1, be: 1, it: 1, this: 1, that: 1,
    i: 1, we: 1, you: 1, my: 1, me: 1, our: 1, your: 1, please: 1, can: 1, could: 1,
    would: 1, should: 1, do: 1, does: 1, did: 1, not: 1, no: 1, yes: 1, just: 1, also: 1,
    from: 1, at: 1, as: 1, by: 1, when: 1, how: 1, what: 1, why: 1, which: 1, there: 1,
    have: 1, has: 1, had: 1, will: 1, up: 1, out: 1, about: 1, into: 1, over: 1, let: 1,
    want: 1, need: 1, make: 1, made: 1, get: 1, got: 1, now: 1, than: 1, them: 1, they: 1,
    its: 1, all: 1, any: 1, some: 1, more: 1, most: 1, very: 1, too: 1, only: 1, like: 1,
  }

  function words(text) {
    return String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter(function (word) {
        return word.length > 2 && STOPWORDS[word] !== 1
      })
  }

  function jaccard(a, b) {
    var left = a instanceof Set ? a : new Set(a)
    var right = b instanceof Set ? b : new Set(b)
    if (left.size === 0 || right.size === 0) return 0
    var shared = 0
    left.forEach(function (word) {
      if (right.has(word)) shared += 1
    })
    var union = left.size + right.size - shared
    return union === 0 ? 0 : shared / union
  }

  /** Heuristic switch detector: a draft that shares no vocabulary with the recent asks. */
  function topicSwitch(draft, recentUserLines) {
    var text = String(draft || '')
    // An explicit marker is a strong signal on its own; length is not required.
    if (/(new task|different task|unrelated|separate task|new question|换个任务|新任务|另一个任务)/i.test(text)) return true
    var draftWords = words(text)
    if (draftWords.length < 8) return false
    var set = new Set(draftWords)
    var best = 0
    for (var i = 0; i < (recentUserLines || []).length; i += 1) {
      var similarity = jaccard(set, words(recentUserLines[i]))
      if (similarity > best) best = similarity
    }
    return best < 0.15
  }

  var VERB = /\b(build|write|add|create|implement|fix|refactor|rename|remove|delete|convert|migrate|split|merge|update|change|extract|move|document|wire|port)\b/i
  var ARTIFACT = /([\w.\\/-]+\.[a-z0-9]{1,8}\b)|\b(file|files|module|function|class|component|route|endpoint|test|tests|schema|config|readme|doc|docs|script|cli|api|plugin|page|panel)\b/i
  var ACCEPT = /\b(done when|acceptance|accepts?|verified|verify|tests? pass|passes|passing|exit 0|expected|should (?:return|print|show|log|render)|asserts?|no errors)\b/i
  var CONSTRAINT = /\b(must|never|don'?t|do not|cannot|can'?t|only|within|at most|at least|no more than|without)\b/i
  var NUMERIC = /(?:^|[^\w])\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins|minutes|h|hours?|kb|mb|gb|px|%|rows?|lines?|words?|items?|files?|tokens?|chars?|calls?)(?:$|[^\w])/i
  var STOP_RULE = /\b(stop when|stop after|then stop|no further|don'?t (?:keep|continue)|and stop|finish after|report and stop|one (?:file|change|module))\b/i
  var ANTI = /\b(be thorough|don(?:'?t| not) stop|until (?:it(?:'?s| is) )?perfect|as much as possible|all possibilities|everything you can|go wild|no limits?|explore everything)\b/i
  var DONE_TEXT = /\b(passed|all tests|exit 0|verified|green)\b|✓/i

  var CHECKS = [
    {
      key: 'deliverable',
      label: 'Deliverable',
      hint: 'name the artifact and the change',
      test: function (text) {
        return VERB.test(text) && ARTIFACT.test(text)
      },
      line: 'Deliverable: <file or artifact> — <the change I want>.',
    },
    {
      key: 'acceptance',
      label: 'Acceptance',
      hint: 'say what proves it works',
      test: function (text) {
        return ACCEPT.test(text)
      },
      line: 'Done when: <the check that must pass>.',
    },
    {
      key: 'constraints',
      label: 'Constraints',
      hint: 'a hard must/never with a number or literal',
      test: function (text) {
        return CONSTRAINT.test(text) && (NUMERIC.test(text) || /`[^`]{1,80}`|"[^"]{1,80}"|'[^']{1,80}'/.test(text) || /[\\/][\w.-]{2,}/.test(text))
      },
      line: 'Must: <hard limit>; never <what to avoid>.',
    },
    {
      key: 'stop',
      label: 'Stop rule',
      hint: 'bound the work',
      test: function (text) {
        return STOP_RULE.test(text)
      },
      line: 'Stop when: <exit condition>; then report and stop.',
    },
    {
      key: 'compact',
      label: 'Size',
      hint: 'keep it under ~40 lines / 600 words, drop "be thorough"',
      test: function (text) {
        if (ANTI.test(text)) return false
        var lineCount = text.split('\n').length
        var wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).length
        return lineCount <= 40 && wordCount <= 600
      },
      line: '',
    },
  ]

  /** Score one draft 0-5 with per-check reasons. Suppressed for `/` commands. */
  function scorePrompt(text) {
    var draft = String(text || '')
    var trimmed = draft.trim()
    if (trimmed === '' || trimmed.charAt(0) === '/') {
      return { suppressed: true, score: 0, checks: [], missing: [], words: 0, lines: 0 }
    }
    var checks = []
    var missing = []
    for (var i = 0; i < CHECKS.length; i += 1) {
      var check = CHECKS[i]
      var ok = false
      try {
        ok = check.test(trimmed) === true
      } catch (error) {
        ok = false
      }
      checks.push({ key: check.key, label: check.label, ok: ok, hint: check.hint, line: check.line })
      if (!ok) missing.push(check.key)
    }
    return {
      suppressed: false,
      score: checks.filter(function (check) { return check.ok }).length,
      checks: checks,
      missing: missing,
      words: trimmed.split(/\s+/).length,
      lines: draft.split('\n').length,
    }
  }

  function scoreColor(score) {
    if (score >= 5) return 'var(--dsh-coach-good, #4ade80)'
    if (score >= 4) return 'var(--dsh-coach-mid, #a3e635)'
    if (score >= 3) return 'var(--dsh-coach-warn, #fbbf24)'
    if (score >= 2) return 'var(--dsh-coach-low, #fb923c)'
    return 'var(--dsh-coach-bad, #f87171)'
  }

  var TEMPLATES = [
    {
      key: 'build',
      label: 'Build',
      hint: 'a new artifact',
      text: [
        'Deliverable: <file or artifact> — <the change I want>.',
        'Must: <hard constraints>; never <what to avoid>.',
        "Done when: <the check that must pass>.",
        "Don't touch: <files or areas to leave alone>.",
        'Stop when: <exit condition>; then report and stop.',
        'Context: <anything the agent cannot infer from the repo>.',
      ].join('\n'),
    },
    {
      key: 'fix',
      label: 'Fix',
      hint: 'a defect with evidence',
      text: [
        'Deliverable: fix <the defect> so <observable behaviour changes>.',
        'Repro: <the exact steps or command I ran>.',
        'Observed: <what happened>; expected: <what should happen>.',
        'Must: <constraints>; never <regressions to allow>.',
        'Done when: <the check that must pass, e.g. the failing test goes green>.',
        'Stop when: the repro passes; then report and stop.',
      ].join('\n'),
    },
    {
      key: 'investigate',
      label: 'Investigate',
      hint: 'a question with a stop rule',
      text: [
        'Deliverable: answer <the exact question> in <form: prose / diff / list>.',
        'Scope: look at <paths or areas>; ignore <what is out of scope>.',
        'Must: cite the files and line numbers you rely on.',
        'Done when: the answer names the cause and the evidence for it.',
        'Stop when: the cause is identified; do not start fixing.',
        'Context: <what I already tried or ruled out>.',
      ].join('\n'),
    },
  ]

  function looksDone(text) {
    return DONE_TEXT.test(String(text || ''))
  }

  function formatTokens(value) {
    var number = Number(value)
    if (!isFinite(number) || number <= 0) return '?'
    if (number >= 1000) return Math.round(number / 1000) + 'k'
    return String(Math.round(number))
  }

  function contextLine(context, red) {
    if (!context || context.ratio === null || context.ratio === undefined) {
      return 'Context size is not reported for this session yet.'
    }
    var percent = Math.round(context.ratio * 100)
    var where = 'of ' + formatTokens(context.compactionAt) + ' tokens'
    if (percent >= Math.round((red || 0.9) * 100)) {
      return 'Context ' + percent + '% ' + where + ' — a new session is cheaper from here.'
    }
    return 'Context ' + percent + '% ' + where + ' — moving to a new session now keeps this one short.'
  }

  // ── shared module state ─────────────────────────────────────────────────────

  var disposals = []
  var ctxRef = null
  /** sessionId -> the turn number from which the chip is visible again. */
  var dismissedUntil = {}

  var css = [
    '.dsh-coach-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:28px;padding:0 6px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#8b8b95);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
    '.dsh-coach-ico{width:15px;height:15px;display:block}',
    '.dsh-coach-btn:hover{background:var(--dsw-alias-bg-l2,#ffffff10);color:var(--dsw-alias-label-primary,#eee)}',
    '.dsh-coach-btn[aria-expanded=true]{background:var(--dsw-alias-bg-l3,#ffffff18);color:var(--dsw-alias-label-primary,#eee)}',
    '.dsh-coach-menu{position:absolute;z-index:40;min-width:196px;padding:5px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#ffffff1f);background:var(--dsw-specific-input-major,#1b1b22);box-shadow:0 10px 30px #0006;display:flex;flex-direction:column;gap:2px}',
    '.dsh-coach-item{display:flex;flex-direction:column;gap:1px;align-items:flex-start;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}',
    '.dsh-coach-item:hover{background:var(--dsw-alias-bg-l2,#ffffff12)}',
    '.dsh-coach-item small{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888)}',
    '.dsh-coach-item[disabled]{opacity:.5;cursor:default}',
    '.dsh-coach-metrics{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 4px;border-radius:8px;background:transparent;border:1px solid transparent;cursor:default}',
    '.dsh-coach-metrics[data-clickable=true]{cursor:pointer}',
    '.dsh-coach-metrics:hover{background:var(--dsw-alias-bg-l2,#ffffff10)}',
    '.dsh-coach-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-bg-l3,#33333d);transition:background .15s ease,transform .15s ease}',
    '.dsh-coach-pop{position:absolute;z-index:40;width:276px;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#ffffff1f);background:var(--dsw-specific-input-major,#1b1b22);box-shadow:0 10px 30px #0006;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#a8a8b3)}',
    '.dsh-coach-pop b{color:var(--dsw-alias-label-primary,#eee);font-weight:600}',
    '.dsh-coach-pop ul{margin:6px 0 0;padding:0 0 0 14px}',
    '.dsh-coach-pop li{margin:2px 0}',
    '.dsh-coach-add{display:inline;margin:0;padding:0 1px;border:0;border-radius:3px;background:transparent;color:var(--dsh-coach-accent,#8b9dff);font:inherit;font-weight:500;font-size:11.5px;line-height:inherit;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}',
    '.dsh-coach-chip{position:absolute;right:12px;top:-13px;z-index:30;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#ffffff26);background:var(--dsw-specific-input-major,#1b1b22);color:var(--dsw-alias-label-secondary,#c8c8d2);font:inherit;font-size:11.5px;line-height:1;cursor:pointer;box-shadow:0 6px 20px #0005;white-space:nowrap}',
    '.dsh-coach-chip:hover{color:var(--dsw-alias-label-primary,#fff)}',
    '.dsh-coach-chip[data-tone=drift]{border-color:#fbbf2455;color:#f7d27a}',
    '.dsh-coach-chip[data-tone=context]{border-color:#f8717155;color:#f7a6a6}',
    '.dsh-coach-chip[data-tone=topic]{border-color:#8b9dff55;color:#b9c3ff}',
    '.dsh-coach-chip[data-tone=done]{border-color:#4ade8055;color:#9ae6b4}',
    '.dsh-coach-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.dsh-coach-action{padding:4px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,#ffffff26);background:var(--dsw-alias-bg-l2,#ffffff10);color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:11.5px;cursor:pointer}',
    '.dsh-coach-action:hover{background:var(--dsw-alias-bg-l3,#ffffff1c)}',
    '.dsh-coach-action[disabled]{opacity:.45;cursor:default}',
    '.dsh-coach-note{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);word-break:break-word}',
    '.dsh-coach-drift{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:0;background:transparent;cursor:default;padding:0}',
    '.dsh-coach-drift span{width:7px;height:7px;border-radius:50%;background:#fbbf24;box-shadow:0 0 0 3px #fbbf2418}',
    '.dsh-coach-drift summary::-webkit-details-marker{display:none}',
    '.dsh-coach-tail{display:flex;align-items:center;gap:8px;margin:6px 0 2px;padding:6px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,#ffffff1f);background:var(--dsw-alias-bg-l1,#ffffff08);color:var(--dsw-alias-label-secondary,#b8b8c4);font-size:12px;line-height:1.4}',
    '.dsh-coach-tail button{all:unset;cursor:pointer;color:var(--dsh-coach-accent,#8b9dff);border-bottom:1px dotted currentColor;font-size:11.5px;white-space:nowrap}',
    '.dsh-coach-tail .dsh-coach-tail-x{margin-left:auto;color:var(--dsw-alias-label-tertiary,#888);border:0;cursor:pointer}',
  ].join('')

  function injectStyle() {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return
    var tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = css
    document.head.appendChild(tag)
  }

  function removeStyle() {
    if (typeof document === 'undefined') return
    var tag = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')
    if (tag !== null) tag.remove()
  }

  function post(path, payload) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {}
        })
        .then(function (body) {
          if (!response.ok || !body || body.ok !== true) {
            var message = (body && body.error && body.error.message) || 'request failed (HTTP ' + response.status + ')'
            throw new Error(message)
          }
          return body.value
        })
    })
  }

  function writeHandoffFile(sessionId) {
    return post(ROUTE, { sessionId: sessionId })
  }

  function startNewSession(prompt) {
    var context = ctxRef
    if (context === null || typeof context.get !== 'function') return false
    var ui = context.get('uiWorkspace')
    if (!ui || typeof ui.startSession !== 'function') return false
    ui.startSession(undefined, { whenDraftExists: 'replace', prompt: prompt })
    return true
  }

  // ── components ──────────────────────────────────────────────────────────────

  function useProjectionSafe(props, key) {
    var read = props && props.useProjection
    if (typeof read !== 'function') return undefined
    try {
      return read(key)
    } catch (error) {
      return undefined
    }
  }

  /** Close a popup when the user clicks anywhere outside its anchor. */
  function useOutsideDismiss(React, anchorRef, open, close) {
    React.useEffect(
      function () {
        if (!open) return undefined
        var onDown = function (event) {
          var node = anchorRef.current
          if (node && !node.contains(event.target)) close()
        }
        document.addEventListener('mousedown', onDown, true)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
        }
      },
      [open],
    )
  }

  function buildTemplateMenu(React, props, label, items) {
    var hh = React.createElement
    var openState = React.useState(false)
    var open = openState[0]
    var setOpen = openState[1]
    var errorState = React.useState('')
    var error = errorState[0]
    var setError = errorState[1]
    var wrapRef = React.useRef(null)
    useOutsideDismiss(React, wrapRef, open, function () {
      setOpen(false)
    })

    var insert = function (text) {
      var actions = props.inputActions
      if (!actions) return
      var draft = typeof props.draft === 'string' ? props.draft : ''
      try {
        if (draft.trim() === '') {
          if (typeof actions.setDraft === 'function') actions.setDraft(text)
        } else {
          var payload = '\n' + text
          var inserted = false
          if (typeof actions.insertText === 'function' && typeof actions.captureInsertion === 'function') {
            inserted = actions.insertText(payload, actions.captureInsertion()) === true
            if (!inserted) inserted = actions.insertText(payload, actions.captureInsertion()) === true
          }
          if (!inserted) setError('The draft changed while inserting — try again.')
        }
      } catch (error) {
        setError('Could not insert the template: ' + (error && error.message ? error.message : error))
      }
      setOpen(false)
    }

    var children = []
    for (var i = 0; i < items.length; i += 1) {
      ;(function (item) {
        children.push(
          hh(
            'button',
            {
              key: item.key,
              type: 'button',
              className: 'dsh-coach-item',
              onClick: function () {
                insert(item.text)
              },
            },
            item.label,
            hh('small', null, item.hint),
          ),
        )
      })(items[i])
    }

    return hh(
      'span',
      { ref: wrapRef, style: { position: 'relative', display: 'inline-flex' } },
      hh(
        'button',
        {
          type: 'button',
          className: 'dsh-coach-btn',
          title: label,
          'aria-label': label,
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () {
            setOpen(!open)
            setError('')
          },
        },
        // A page glyph, not another "+": the composer already has an attachment "+".
        hh(
          'svg',
          { className: 'dsh-coach-ico', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
          hh('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
          hh('path', { d: 'M5.2 6h5.6M5.2 8.4h5.6M5.2 10.8h3.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        ),
      ),
      open
        ? hh(
            'div',
            {
              className: 'dsh-coach-menu',
              style: { bottom: '32px', left: '0' },
            },
            children,
          )
        : null,
      error === '' ? null : hh('div', { className: 'dsh-coach-note', style: { position: 'absolute', top: '30px', left: 0, width: '200px' } }, error),
    )
  }

  /** C1 — template inserter at the left of the composer tool row. */
  function TemplateControl(props) {
    var React = h.React
    var draft = props.useInput(function (state) {
      return state.draft
    })
    var view = useProjectionSafe(props, PROJECTION)
    if (view && view.flags && view.flags.templates === false) return null
    return buildTemplateMenu(React, { inputActions: props.inputActions, draft: draft }, 'Insert a prompt template', TEMPLATES)
  }

  /** C2 — live draft meter: five dots, a tooltip of missing pieces, add-only inserts. */
  function DraftMeter(props) {
    var React = h.React
    var hh = React.createElement
    var draft = props.useInput(function (state) {
      return state.draft
    })
    var view = useProjectionSafe(props, PROJECTION)
    var scoreState = React.useState(null)
    var scored = scoreState[0]
    var setScored = scoreState[1]
    var hoverState = React.useState(false)
    var hovering = hoverState[0]
    var setHovering = hoverState[1]
    var pinnedState = React.useState(false)
    var pinned = pinnedState[0]
    var setPinned = pinnedState[1]
    var wrapRef = React.useRef(null)
    useOutsideDismiss(React, wrapRef, pinned, function () {
      setPinned(false)
    })
    var errorState = React.useState('')
    var error = errorState[0]
    var setError = errorState[1]

    React.useEffect(function () {
      var timer = setTimeout(function () {
        setScored(scorePrompt(draft))
      }, 300)
      return function () {
        clearTimeout(timer)
      }
    }, [draft])

    if (view && view.flags && view.flags.meter === false) return null
    if (scored === null) return null
    if (scored.suppressed) return null

    var add = function (line) {
      var actions = props.inputActions
      if (!actions || typeof actions.insertText !== 'function' || typeof actions.captureInsertion !== 'function') return
      var payload = '\n' + line
      var ok = false
      try {
        ok = actions.insertText(payload, actions.captureInsertion()) === true
        if (!ok) ok = actions.insertText(payload, actions.captureInsertion()) === true
      } catch (failure) {
        ok = false
      }
      setError(ok ? '' : 'The draft changed while inserting — try again.')
    }

    var dots = []
    for (var i = 0; i < scored.checks.length; i += 1) {
      var check = scored.checks[i]
      dots.push(
        hh('span', {
          key: check.key,
          className: 'dsh-coach-dot',
          style: { background: check.ok ? scoreColor(scored.score) : undefined },
        }),
      )
    }

    var missingRows = []
    for (var j = 0; j < scored.checks.length; j += 1) {
      var entry = scored.checks[j]
      if (entry.ok) continue
      missingRows.push(
        hh(
          'li',
          { key: entry.key },
          hh('b', null, entry.label),
          ' — ' + entry.hint + ' ',
          entry.line === ''
            ? null
            : hh(
                // A span, not a button: the host theme styles every <button> in the
                // composer, and this sits inside a popover as inline text.
                'span',
                {
                  className: 'dsh-coach-add',
                  role: 'button',
                  tabIndex: 0,
                  onClick: function (line) {
                    return function () {
                      add(line)
                    }
                  }(entry.line),
                  onKeyDown: function (line) {
                    return function (event) {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      add(line)
                    }
                  }(entry.line),
                },
                'add line',
              ),
        ),
      )
    }

    return hh(
      'span',
      { ref: wrapRef, style: { position: 'relative', display: 'inline-flex' } },
      hh(
        'span',
        {
          className: 'dsh-coach-metrics',
          'data-clickable': scored.missing.length > 0 ? 'true' : 'false',
          onMouseEnter: function () {
            setHovering(true)
          },
          onMouseLeave: function () {
            setHovering(false)
          },
          onClick: function () {
            setPinned(!pinned)
          },
          title: 'Draft ' + scored.score + '/5 — ' + scored.words + ' words, ' + scored.lines + ' lines',
        },
        dots,
      ),
      hovering || pinned || error !== ''
        ? hh(
            'div',
            {
              className: 'dsh-coach-pop',
              style: { bottom: '32px', right: '0' },
              onMouseEnter: function () {
                setHovering(true)
              },
              onMouseLeave: function () {
                setHovering(false)
              },
            },
            hh('b', null, 'Draft ' + scored.score + '/5'),
            scored.missing.length === 0
              ? hh('div', { style: { marginTop: '4px' } }, 'Everything a tight prompt needs is here.')
              : hh(
                  'div',
                  null,
                  'Missing:',
                  hh('ul', null, missingRows),
                ),
            error === '' ? null : hh('div', { className: 'dsh-coach-note' }, error),
          )
        : null,
    )
  }

  function coachReason(view, draft, sessionId) {
    if (!view || !view.flags) return null
    if (view.flags.nudge === false) return null
    var until = dismissedUntil[sessionId]
    if (typeof until === 'number' && view.turns <= until) return null
    var context = view.context || {}
    var ratio = typeof context.ratio === 'number' ? context.ratio : null
    var amber = view.thresholds && typeof view.thresholds.amber === 'number' ? view.thresholds.amber : 0.7
    var red = view.thresholds && typeof view.thresholds.red === 'number' ? view.thresholds.red : 0.9
    if (view.flags.drift !== false && view.drift && view.drift.changed === true) {
      return { tone: 'drift', copy: 'Setup changed mid-session: ' + (view.drift.line || 'model, effort or tools moved') + '.' }
    }
    if (ratio !== null && ratio >= red) {
      return { tone: 'context', copy: contextLine(context, red) }
    }
    if ((view.users || []).length > 0 && topicSwitch(draft, view.users)) {
      return { tone: 'topic', copy: 'This reads like a new task — a fresh session keeps the context small.' }
    }
    if (view.done === true && ratio !== null && ratio >= amber) {
      return { tone: 'done', copy: contextLine(context, red) }
    }
    return null
  }

  /** C3 — the freshness chip floating over the composer. */
  function CoachMark(props) {
    var React = h.React
    var hh = React.createElement
    var draft = props.useInput(function (state) {
      return state.draft
    })
    var view = useProjectionSafe(props, PROJECTION)
    var openState = React.useState(false)
    var open = openState[0]
    var setOpen = openState[1]
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]
    var noteState = React.useState('')
    var note = noteState[0]
    var setNote = noteState[1]
    var wrapRef = React.useRef(null)
    useOutsideDismiss(React, wrapRef, open, function () {
      setOpen(false)
    })

    var reason = coachReason(view, draft, props.sessionId)
    if (reason === null) return null

    var title = reason.tone === 'drift' ? 'Setup drift' : reason.tone === 'context' ? 'Context is long' : reason.tone === 'topic' ? 'New task?' : 'Task looks done'

    var writeFile = function () {
      setBusy(true)
      setNote('')
      writeHandoffFile(props.sessionId)
        .then(function (value) {
          setNote('Written: ' + value.path)
        })
        .catch(function (error) {
          setNote('Could not write the handoff: ' + (error && error.message ? error.message : error))
        })
        .then(function () {
          setBusy(false)
        })
    }

    var startFresh = function () {
      var markdown = view && view.handoff ? view.handoff.markdown : ''
      if (markdown === '') {
        setNote('The handoff is still empty — send a message first.')
        return
      }
      setBusy(true)
      setNote('')
      writeHandoffFile(props.sessionId)
        .then(function (value) {
          if (startNewSession(markdown)) {
            setNote('New session opened; the handoff file is at ' + value.path)
          } else {
            setNote('Could not open a new session here; the handoff file is at ' + value.path)
          }
        })
        .catch(function () {
          if (startNewSession(markdown)) {
            setNote('New session opened with the handoff in the draft.')
          } else {
            setNote('Could not open a new session here.')
          }
        })
        .then(function () {
          setBusy(false)
          setOpen(false)
        })
    }

    var dismiss = function () {
      var turns = view && typeof view.turns === 'number' ? view.turns : 0
      dismissedUntil[props.sessionId] = turns + 2
      setOpen(false)
      setNote('')
    }

    return hh(
      'span',
      { ref: wrapRef, style: { position: 'absolute', right: '12px', top: '-13px', zIndex: 30 } },
      hh(
        'button',
        {
          type: 'button',
          className: 'dsh-coach-chip',
          'data-tone': reason.tone,
          title: title + ' — click for handoff options',
          onClick: function () {
            setOpen(!open)
          },
        },
        hh('span', null, title),
      ),
      open
        ? hh(
            'div',
            { className: 'dsh-coach-pop', style: { bottom: '32px', right: '0' } },
            hh('div', null, reason.copy),
            hh(
              'div',
              { className: 'dsh-coach-actions' },
              hh(
                'button',
                { type: 'button', className: 'dsh-coach-action', disabled: busy, onClick: writeFile },
                'Write handoff',
              ),
              hh(
                'button',
                { type: 'button', className: 'dsh-coach-action', disabled: busy, onClick: startFresh },
                'New session with handoff',
              ),
              hh(
                'button',
                { type: 'button', className: 'dsh-coach-action', disabled: busy, onClick: dismiss },
                'Not now',
              ),
            ),
            note === '' ? null : hh('div', { className: 'dsh-coach-note' }, note),
          )
        : null,
    )
  }

  /** C3 (turn-tail variant) — one line after a completed turn. */
  function TurnTailNudge(props) {
    var React = h.React
    var hh = React.createElement
    var view = useProjectionSafe(props, PROJECTION)
    var noteState = React.useState('')
    var note = noteState[0]
    var setNote = noteState[1]
    if (!view || !view.flags || view.flags.nudge === false) return null
    var until = dismissedUntil[props.sessionId]
    if (typeof until === 'number' && view.turns <= until) return null
    var context = view.context || {}
    var ratio = typeof context.ratio === 'number' ? context.ratio : null
    var amber = view.thresholds && typeof view.thresholds.amber === 'number' ? view.thresholds.amber : 0.7
    if (view.done !== true || ratio === null || ratio < amber) return null
    if (note !== '') return hh('div', { className: 'dsh-coach-tail' }, note)
    return hh(
      'div',
      { className: 'dsh-coach-tail' },
      hh('span', null, 'This turn looks finished and the context is ' + Math.round(ratio * 100) + '% full.'),
      hh(
        'button',
        {
          type: 'button',
          onClick: function () {
            var markdown = view.handoff ? view.handoff.markdown : ''
            writeHandoffFile(props.sessionId)
              .then(function (value) {
                return startNewSession(markdown) ? 'New session opened with the handoff. File: ' + value.path : 'Handoff written to ' + value.path
              })
              .catch(function () {
                return startNewSession(markdown) ? 'New session opened with the handoff in the draft.' : 'Could not write the handoff.'
              })
              .then(function (message) {
                setNote(message)
              })
          },
        },
        'Hand off →',
      ),
      hh(
        'button',
        {
          type: 'button',
          className: 'dsh-coach-tail-x',
          title: 'Hide this for 2 turns',
          onClick: function () {
            var turns = typeof view.turns === 'number' ? view.turns : 0
            dismissedUntil[props.sessionId] = turns + 2
            setNote('')
          },
        },
        '×',
      ),
    )
  }

  /** C4 — the setup-drift dot in the header corner. */
  function DriftDot(props) {
    var React = h.React
    var hh = React.createElement
    var view = useProjectionSafe(props, PROJECTION)
    if (!view || !view.flags || view.flags.drift === false) return null
    if (!view.drift || view.drift.changed !== true) return null
    var detail = view.drift.line || 'model, effort or tools changed'
    return hh(
      'span',
      { className: 'dsh-coach-drift', title: detail + ' — a new session starts from the new setup' },
      hh('span', null),
    )
  }

  // ── registration ────────────────────────────────────────────────────────────

  function register(ctx, key, options, Component) {
    if (ctx === null || !ctx.slots) return
    var fiber
    try {
      fiber = ctx.slots.inject(key, function () {
        return ctx.slots.register(options, Component)
      })
    } catch (error) {
      return
    }
    disposals.push(function () {
      try {
        if (fiber !== null && typeof fiber.dispose === 'function') fiber.dispose()
      } catch (error) {
        /* already gone */
      }
    })
  }

  function apply(ctx) {
    ctxRef = ctx
    injectStyle()

    register(ctx, 'conversation.input.left', { name: 'conversation.input.left', id: PLUGIN + '-templates', order: 6, registrant: PLUGIN }, TemplateControl)
    register(ctx, 'conversation.input.right', { name: 'conversation.input.right', id: PLUGIN + '-meter', order: 30, registrant: PLUGIN }, DraftMeter)
    register(ctx, 'conversation.input.overlay', { name: 'conversation.input.overlay', id: PLUGIN + '-freshness', order: 20, registrant: PLUGIN }, CoachMark)
    register(ctx, 'conversation.chat.turnTail', { name: 'conversation.chat.turnTail', id: PLUGIN + '-tail', order: 5, registrant: PLUGIN }, TurnTailNudge)
    // The header corner is a `single` slot: a lower priority than the shipped
    // occupant is what claims the cell (the same rule dsh-incognito uses to
    // shadow the stock composer bar).
    register(ctx, 'conversation.session.header.corner', { name: 'conversation.session.header.corner', priority: -1, registrant: PLUGIN }, DriftDot)

    if (typeof ctx.effect === 'function') {
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposals.length; i += 1) disposals[i]()
          disposals = []
          dismissedUntil = {}
          removeStyle()
          ctxRef = null
        }
      }, 'dsh-coach.client')
    }
  }

  window.__ModuleLoader__.load({
    id: PLUGIN,
    factory: function (require) {
      var React = require('react')
      h = { React: React, createElement: React.createElement }
      return {
        name: PLUGIN,
        inject: ['slots'],
        apply: apply,
        __test: {
          scorePrompt: scorePrompt,
          jaccard: jaccard,
          words: words,
          topicSwitch: topicSwitch,
          looksDone: looksDone,
          coachReason: coachReason,
          TEMPLATES: TEMPLATES,
          CHECKS: CHECKS,
          dismiss: function (sessionId, untilTurn) {
            dismissedUntil[sessionId] = untilTurn
          },
          clearDismissals: function () {
            dismissedUntil = {}
          },
        },
      }
    },
  })
})()
