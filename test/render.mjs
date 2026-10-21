/**
 * Render checks for the browser half.
 *
 * This does not need a DOM. React is replaced by a stub whose hooks return
 * their initial values, the component function is called directly, and the
 * element tree it returns is inspected. That still executes every line of the
 * render path, which is what catches the mistakes a syntax check misses — a
 * misspelled variable, a component used before it is defined, a missing branch.
 *
 * `apply` is also driven against a fake host so the slot contracts stay honest:
 * the shell sorts the sidebar row by `id` and `order`, and a registration that
 * loses either one silently stops appearing.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = new URL('../src/client.js', import.meta.url)
const src = readFileSync(SOURCE, 'utf8')

let hookIndex = 0
let record = null
let overrides = {}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => {
    const index = hookIndex++
    if (record) record.push(init)
    const has = Object.prototype.hasOwnProperty.call(overrides, index)
    return [has ? overrides[index] : init, () => {}]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (component) => component,
  Fragment: 'Fragment'
}

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

check('the module registers itself with the host loader', !!definition)
check('the module id matches the package name', definition && definition.id === 'dsh-skill-hub', definition && definition.id)

const mod = definition.factory((name) => (name === 'react' ? React : {}))
check('the factory exports the apply entry point', typeof mod.apply === 'function')
check(
  'the factory declares the services it depends on',
  Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('connection'),
  JSON.stringify(mod.inject)
)

// ── drive apply against a fake host ───────────────────────────────────────
const registered = []
const rpc = { call: () => Promise.resolve({ ok: true, value: {} }) }
const ctx = {
  get: (name) => (name === 'connection' ? { rpc } : undefined),
  effect: (fn) => {
    fn()
  },
  on: () => {},
  slots: {
    inject: (owner, callback) => callback(),
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
    subscribe: () => () => {},
    entriesOfSlot: () => []
  }
}
mod.apply(ctx)

const seats = registered.map((entry) => entry.options.name).sort()
check(
  'apply claims the sidebar row, the page and the composer chip',
  seats.join(',') === 'conversation.input.left,main,sidebar.panellist',
  seats.join(',')
)

const sidebarRow = registered.find((entry) => entry.options.name === 'sidebar.panellist')
check('the sidebar row carries the id the shell sorts on', sidebarRow && sidebarRow.options.id === 'skill-hub')
check(
  'the sidebar row carries an order so it does not sort last',
  sidebarRow && typeof sidebarRow.options.order === 'number',
  sidebarRow && String(sidebarRow.options.order)
)
check(
  'the sidebar label resolves to Chinese text',
  sidebarRow && sidebarRow.options.label() === '技能·专家',
  sidebarRow && sidebarRow.options.label()
)

const page = registered.find((entry) => entry.options.name === 'main')
check('the page is registered under the same key', page && page.options.key === 'skill-hub')
check('the page injects the rpc handle', page && !!page.options.inject().rpc)

// ── walk the element tree ─────────────────────────────────────────────────
const collect = (tree) => {
  const texts = []
  const classNames = []
  const untyped = []
  const visit = (node) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node === 'object') {
      if (node.type === undefined || node.type === null) untyped.push(node)
      if (node.props && typeof node.props.className === 'string') classNames.push(node.props.className)
      ;(node.children || []).forEach(visit)
    }
  }
  visit(tree)
  return { texts, classNames, untyped }
}

// Pass 1: the state a fresh mount actually has.
hookIndex = 0
record = []
overrides = {}
const first = page.component({ rpc })
const initials = record.slice()
record = null
const fresh = collect(first)

check('a fresh mount renders without throwing', !!first)
check('no element is created without a type', fresh.untyped.length === 0, String(fresh.untyped.length))
check('the tab strip offers the market tab', fresh.texts.includes('技能'))
check('the tab strip offers the experts tab', fresh.texts.includes('专家'))
check('the tab strip offers the installed tab', fresh.texts.includes('已安装'))

// Locate the roster slot by shape: null followed by the three empty strings
// that back the department filter, the roster error and the expert query.
const rosterIndex = initials.findIndex(
  (value, index) =>
    value === null &&
    initials[index + 1] === '' &&
    initials[index + 2] === '' &&
    initials[index + 3] === ''
)
check('the roster state slot is discoverable', rosterIndex >= 0, String(rosterIndex))

const roster = {
  repo: 'jnMetaCode/agency-agents-zh',
  ref: 'main',
  total: 2,
  departments: [
    { key: 'engineering', label: '工程部', emoji: '🛠️', count: 1, experts: [] },
    { key: 'design', label: '设计部', emoji: '🎨', count: 1, experts: [] }
  ],
  experts: [
    {
      stem: 'engineering-frontend-developer',
      name: '前端开发者',
      path: 'engineering/engineering-frontend-developer.md',
      deptKey: 'engineering',
      deptLabel: '工程部',
      emoji: '🛠️',
      summary: '精通 React/Vue 的前端专家',
      installed: false
    },
    {
      stem: 'design-ui-designer',
      name: 'UI 设计师',
      path: 'design/design-ui-designer.md',
      deptKey: 'design',
      deptLabel: '设计部',
      emoji: '🎨',
      summary: '负责界面视觉',
      installed: true
    }
  ]
}

// Pass 2: the experts tab with a roster loaded.
hookIndex = 0
overrides = { 0: 'experts', [rosterIndex]: roster }
const second = page.component({ rpc })
overrides = {}
const loaded = collect(second)

check('the experts tab renders with a roster', !!second)
check('the roster hint is shown', loaded.texts.some((line) => line.includes('选一位专家')))
check('both experts are listed', loaded.texts.includes('前端开发者') && loaded.texts.includes('UI 设计师'))
check('the department headings are shown', loaded.texts.includes('工程部') && loaded.texts.includes('设计部'))
check(
  'the department filter lists every department plus "all"',
  loaded.texts.includes('全部部门') && loaded.texts.includes('🛠️ 工程部') && loaded.texts.includes('🎨 设计部')
)
check('an installed expert shows the added label', loaded.texts.includes('已加入'))
check(
  'each expert renders as one shared row',
  loaded.classNames.filter((name) => name === 'dsh-sh-row').length === 2,
  String(loaded.classNames.filter((name) => name === 'dsh-sh-row').length)
)

// Pass 3: filtering to one department hides the other.
hookIndex = 0
overrides = { 0: 'experts', [rosterIndex]: roster, [rosterIndex + 1]: 'design' }
const third = page.component({ rpc })
overrides = {}
const filtered = collect(third)
check(
  'choosing a department shows only its members',
  filtered.texts.includes('UI 设计师') && !filtered.texts.includes('前端开发者')
)

// Pass 4: an empty roster falls back to the empty state instead of a blank page.
hookIndex = 0
overrides = { 0: 'experts', [rosterIndex]: { departments: [], experts: [], total: 0 } }
const fourth = page.component({ rpc })
overrides = {}
const empty = collect(fourth)
check('an empty roster renders the empty state', empty.texts.includes('专家名单暂时不可用'))

console.log('')
if (failures.length) {
  console.log(failures.length + ' failure(s):')
  failures.forEach((line) => console.log('  - ' + line))
  process.exit(1)
}
console.log('All render checks passed.')
