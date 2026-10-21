/**
 * Flow checks for the browser half: render → effect → response → re-render.
 *
 * `render.mjs` replaces every hook with its initial value, which exercises the
 * render path but never the data path: no effect runs, so a component that
 * renders an empty grid before its first response and never updates after it
 * still passes there. That gap is exactly where "the panel is blank" lives, so
 * this harness implements the parts of React the component actually uses —
 * state cells that survive a re-render, effects that run once per dependency
 * change, and cleanups that run before the next pass.
 *
 * The fake host returns canned route payloads; nothing here touches the network
 * or a real DOM.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = new URL('../src/client.js', import.meta.url)
const src = readFileSync(SOURCE, 'utf8')

// ── a small React with real hook semantics ────────────────────────────────

let cells = [] // one entry per hook slot, in call order
let cursor = 0
let effects = [] // effects of the pass being rendered
let pending = [] // effects whose dependencies changed

const same = (a, b) => {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => {
    const index = cursor++
    if (index >= cells.length) cells.push({ kind: 'state', value: init })
    const cell = cells[index]
    const set = (next) => {
      cell.value = typeof next === 'function' ? next(cell.value) : next
    }
    return [cell.value, set]
  },
  useRef: (init) => {
    const index = cursor++
    if (index >= cells.length) cells.push({ kind: 'ref', value: { current: init === undefined ? null : init } })
    return cells[index].value
  },
  useEffect: (fn, deps) => {
    const index = cursor++
    const previous = index < cells.length ? cells[index] : null
    if (!previous) cells.push({ kind: 'effect', deps: deps || null, cleanup: null })
    const cell = cells[index]
    const changed = !deps || !previous || !same(previous.deps, deps)
    if (changed) {
      cell.deps = deps || null
      pending.push({ cell, fn })
    }
  },
  useLayoutEffect: () => {},
  useCallback: (fn, deps) => {
    const index = cursor++
    const previous = index < cells.length ? cells[index] : null
    if (!previous) cells.push({ kind: 'callback', deps: deps || null, fn })
    const cell = cells[index]
    if (!deps || !previous || !same(previous.deps, deps)) {
      cell.deps = deps || null
      cell.fn = fn
    }
    return cell.fn
  },
  useMemo: (fn, deps) => {
    const index = cursor++
    const previous = index < cells.length ? cells[index] : null
    if (!previous) cells.push({ kind: 'memo', deps: deps || null, value: fn() })
    const cell = cells[index]
    if (!deps || !previous || !same(previous.deps, deps)) {
      cell.deps = deps || null
      cell.value = fn()
    }
    return cell.value
  },
  memo: (component) => component,
  Fragment: 'Fragment'
}

// ── load the module ───────────────────────────────────────────────────────

let definition = null
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => { definition = value } } },
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  Promise,
  Set,
  Map,
  JSON,
  Math,
  Date,
  Error,
  Object,
  Array,
  String,
  Number,
  Boolean,
  RegExp
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(label + (detail ? ' — ' + detail : ''))
  console.log((ok ? 'PASS ' : 'FAIL ') + label)
}

// ── a host whose routes answer with fixed payloads ────────────────────────

const rows = [
  {
    id: 'skillhub:@ake/dev-god',
    source: 'skillhub',
    sourceLabel: 'SkillHub',
    slug: 'dev-god',
    name: '编程大神',
    displayName: '编程大神',
    summary: '面向复杂真实项目的高阶全栈编程助手',
    summaryZh: '面向复杂真实项目的高阶全栈编程助手',
    tags: ['编程'],
    downloads: 1234,
    installed: false
  },
  {
    id: 'clawhub:qizhitang/xiaozhi-learning-plan',
    source: 'clawhub',
    sourceLabel: 'ClawHub',
    slug: 'xiaozhi-learning-plan',
    name: '学习计划制定师',
    displayName: '学习计划制定师',
    summary: '把学习目标拆成可执行的 30 天方案',
    tags: ['学习计划'],
    downloads: 1783,
    installed: false
  }
]

const answers = {
  sources: { sources: [{ id: 'skillhub', label: 'SkillHub' }, { id: 'clawhub', label: 'ClawHub' }] },
  categories: {
    categories: [
      { key: 'dev-programming', name: '开发编程', nameEn: 'Dev Programming' },
      { key: 'office-efficiency', name: '办公效率', nameEn: 'Office' }
    ]
  },
  search: {
    items: rows,
    total: 2,
    page: 1,
    pageSize: 30,
    hasMore: false,
    sources: ['skillhub', 'clawhub'],
    errors: [],
    diagnostics: [
      { source: 'skillhub', count: 1, skipped: '', error: '' },
      { source: 'clawhub', count: 1, skipped: '', error: '' }
    ]
  },
  installed: { skills: [], dir: '/skills' }
}

const calls = []
const rpc = {
  call: (channel, endpoint, payload, signal) => {
    calls.push({ channel, endpoint, payload })
    const key = endpoint.replace(/^skill-hub\//, '')
    if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    return Promise.resolve({ ok: true, value: answers[key] === undefined ? {} : answers[key] })
  }
}

// ── render loop ───────────────────────────────────────────────────────────

const page = (() => {
  const registered = []
  const ctx = {
    get: (name) => (name === 'connection' ? { rpc } : undefined),
    effect: (fn) => { fn() },
    on: () => {},
    slots: {
      inject: (owner, callback) => callback(),
      register: (options, component) => { registered.push({ options, component }); return () => {} },
      subscribe: () => () => {},
      entriesOfSlot: () => []
    }
  }
  definition.factory((name) => (name === 'react' ? React : {})).apply(ctx)
  return registered.find((entry) => entry.options.name === 'main')
})()

const collect = (tree) => {
  const texts = []
  const classNames = []
  // Function components must be *invoked*: `h(SkillCard, ...)` is a call
  // request, not markup, so a walker that only descends into `children` sees an
  // empty element and reports "nothing rendered" for a perfectly good tree.
  const visit = (node) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') {
      const saved = cursor
      cursor = 0
      const rendered = node.type(node.props || {})
      cursor = saved
      visit(rendered)
      return
    }
    if (node.props && typeof node.props.className === 'string') classNames.push(node.props.className)
    ;(node.children || []).forEach(visit)
  }
  visit(tree)
  return { texts, classNames }
}

/** Render once, then run every effect whose dependencies changed. */
const pass = () => {
  cursor = 0
  pending = []
  const tree = page.component({ rpc })
  const batch = pending
  pending = []
  for (const item of batch) {
    if (item.cell.cleanup) item.cell.cleanup()
    item.cell.cleanup = item.fn() || null
  }
  return collect(tree)
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    pass()
  }
}

// ── checks ────────────────────────────────────────────────────────────────

const first = pass()
// `loading` starts true, so the first paint is the spinner: the panel must not
// flash "nothing matched" before the very first response arrives.
check('the first paint is the loading state, not an empty grid', first.texts.includes('加载中') || first.classNames.includes('dsh-sh-state'), first.texts.slice(0, 6).join(' | '))

await settle()
const after = pass()

check('the search was actually issued', calls.some((entry) => entry.endpoint === 'skill-hub/search'), JSON.stringify(calls.map((c) => c.endpoint)))
check(
  'the call uses the four-argument contract',
  calls.every((entry) => entry.channel === '/api' && !entry.endpoint.startsWith('/')),
  JSON.stringify(calls[0])
)
check('the empty state is gone once rows arrive', !after.texts.includes('没有匹配的技能'), after.texts.slice(0, 8).join(' | '))
check('both rows render', after.texts.includes('编程大神') && after.texts.includes('学习计划制定师'))
check('the Chinese summary is preferred', after.texts.some((line) => line.includes('高阶全栈编程助手')))
check(
  'each row is one card',
  after.classNames.filter((name) => name.includes('dsh-sh-card')).length >= 2,
  String(after.classNames.filter((name) => name.includes('dsh-sh-card')).length)
)
check('the category pills are rendered', after.texts.includes('开发编程') && after.texts.includes('办公效率'))
check('the source chips are rendered', after.texts.includes('SkillHub') && after.texts.includes('ClawHub'))
check('the diagnostics row is not shown while rows exist', !after.classNames.includes('dsh-sh-diag'))

// A source filter is honoured: picking ClawHub asks the host for that source only.
const beforeSwitch = calls.length
pass()
const page2 = page.component({ rpc })
void page2
const sourceChipIndex = (() => {
  // Drive the click the way the UI does: find the chip's onClick through a render.
  cursor = 0
  pending = []
  const tree = page.component({ rpc })
  let handler = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props && node.props.className === 'dsh-sh-chip' && node.children && String(node.children.join('')) === 'ClawHub') {
      handler = node.props.onClick
    }
    ;(node.children || []).forEach(walk)
  }
  walk(tree)
  return handler
})()
check('the ClawHub chip has a click handler', typeof sourceChipIndex === 'function')
if (typeof sourceChipIndex === 'function') {
  sourceChipIndex()
  await settle()
  const switched = pass()
  const last = calls[calls.length - 1]
  check('choosing ClawHub asks for that source', last && last.payload && last.payload.source === 'clawhub', JSON.stringify(last && last.payload))
  check('the category row is hidden for ClawHub', !switched.texts.includes('开发编程'), switched.texts.slice(0, 6).join(' | '))
  check('the rows still render after the switch', switched.texts.includes('编程大神') || switched.texts.includes('学习计划制定师'))
  check('the switch actually re-ran the search', calls.length > beforeSwitch, String(calls.length - beforeSwitch))
}

console.log('')
if (failures.length) {
  console.log(failures.length + ' failure(s):')
  failures.forEach((line) => console.log('  - ' + line))
  process.exit(1)
}
console.log('All flow checks passed.')
