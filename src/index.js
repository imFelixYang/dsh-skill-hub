/**
 * dsh-skill-hub — host half.
 *
 * Exposes a small JSON surface under `/api/skill-hub/*`. The browser half talks
 * to it through the Connection RPC route, so no shared /api interceptor is
 * installed (the official gateway owns that channel).
 *
 * The surface is source-agnostic. Every catalogue is adapted into ONE item
 * shape, so the client never needs to know where a skill came from:
 *
 *   skillhub  Tencent SkillHub (api.skillhub.tencent.com) — Chinese metadata
 *   clawhub   ClawHub (clawhub.ai) — large English registry
 *   github    Any repo laid out as <dir>/SKILL.md, read through jsDelivr so
 *             browsing consumes no GitHub API quota (60 req/h unauthenticated)
 *
 * Endpoints (all POST, body is the standard RPC envelope):
 *   sources | categories | search | detail | installed | install | uninstall
 *
 * Design rules kept throughout:
 *   • one bad source never fails the request — it degrades to a partial result
 *   • every source has its own timeout, so one slow registry cannot stall a search
 *   • nothing is written outside the resolved skills directory
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const name = 'dsh-skill-hub'
export const inject = ['connection', 'skills']

// ── defaults ────────────────────────────────────────────────────────────────

const DEFAULT_SKILLHUB_API = 'https://api.skillhub.tencent.com'

/**
 * SkillHub answers from more than one host and the payloads are byte-identical,
 * so they are treated as mirrors rather than separate sources: whichever host
 * replies first is used, and a host that refuses, times out or errors is simply
 * skipped in favour of the next one. The Tencent host leads because it measured
 * about twice as fast as the `.cn` host from mainland China.
 */
const DEFAULT_SKILLHUB_MIRRORS = ['https://api.skillhub.tencent.com', 'https://api.skillhub.cn']
const DEFAULT_CLAWHUB_API = 'https://clawhub.ai'
const DEFAULT_JSDELIVR_DATA = 'https://data.jsdelivr.com'
const DEFAULT_JSDELIVR_CDN = 'https://cdn.jsdelivr.net'
const DEFAULT_GITHUB_API = 'https://api.github.com'
const DEFAULT_GITHUB_RAW = 'https://raw.githubusercontent.com'

/**
 * Curated GitHub catalogues. All of these use the `<dir>/SKILL.md` layout, so
 * the same adapter reads them. Add your own with `githubRepos` in the patch.
 *
 * Order matters: when two catalogues ship a skill under the same directory name
 * the first one wins, so the upstream author is listed ahead of mirrors/forks.
 */
const DEFAULT_GITHUB_REPOS =
  'anthropics/skills@main,' +
  'obra/superpowers@main,' +
  'rohitg00/awesome-claude-code-toolkit@main,' +
  'ComposioHQ/awesome-claude-skills@master'

/**
 * The Chinese expert roster. Unlike the skill catalogues this is a fixed, hand
 * written list of role prompts, so it gets its own tab instead of being mixed
 * into keyword search. Two documents describe it: `CATALOG.md` maps a Chinese
 * display name to its markdown file (grouped under department headings), and
 * `AGENT-LIST.md` carries the one line blurb for the same id.
 */
const DEFAULT_EXPERTS_REPO = 'jnMetaCode/agency-agents-zh@main'
const DEFAULT_EXPERTS_CATALOG = 'CATALOG.md'
const DEFAULT_EXPERTS_ROSTER = 'AGENT-LIST.md'

const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024
const MAX_README_CHARS = 400 * 1024

/** Chinese labels for the SkillHub category keys. The API only ships English. */
const CATEGORY_ZH = {
  // "Pay Skill" is the upstream product name, not a "paid" tier — the site
  // lists it verbatim, so translating it to 付费技能 read like a paywall.
  'pay-skill': 'Pay Skill',
  'office-efficiency': '办公效率',
  'content-creation': '内容创作',
  'dev-programming': '开发编程',
  'data-analysis': '数据分析',
  'design-media': '设计多媒体',
  'ai-agent': 'AI Agent',
  'knowledge-management': '知识管理',
  'business-ops': '商业运营',
  'education': '教育学习',
  'professional': '行业专业',
  'it-ops-security': 'IT 运维与安全',
  'life-service': '生活服务'
}

/**
 * Category keys that are not offered as a scenario filter. "pay-skill" is a
 * payment product line rather than a use case, so it stays in the catalogue but
 * not in the sidebar; the API-key dimension covers what it used to imply.
 */
const HIDDEN_CATEGORY_KEYS = new Set(['pay-skill'])

/** Error codes the RPC layer accepts; anything else is reported as `internal`. */const ERROR_CODES = new Set([
  'bad-request',
  'cancelled',
  'internal',
  'command-error',
  'unknown-command',
  'settings-rejected',
  'credential-rejected'
])

// ── result envelope ─────────────────────────────────────────────────────────

function ok(value) {
  return { ok: true, value }
}

function fail(code, message, details) {
  const safeCode = ERROR_CODES.has(code) ? code : 'internal'
  return { ok: false, error: { code: safeCode, message: String(message || ''), details: details || {} } }
}

// ── small helpers ───────────────────────────────────────────────────────────

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function toPositiveInt(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  const rounded = Math.floor(n)
  return max && rounded > max ? max : rounded
}

function clampText(value, max) {
  const text = String(value == null ? '' : value)
  return text.length > max ? text.slice(0, max) : text
}

function isAbort(error) {
  return !!error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * Reject a directory name that could escape the skills root. A slug arrives
 * from the network and is later used as `join(skillsDir, slug)` followed by a
 * recursive delete, so anything but a single plain path segment is refused.
 */
function safeSkillDirName(raw) {
  const value = String(raw == null ? '' : raw).trim()
  if (!value) return ''
  if (value === '.' || value === '..') return ''
  if (value.includes('/') || value.includes('\\')) return ''
  if (value.includes('\0')) return ''
  if (/^[a-zA-Z]:/.test(value)) return ''
  return value
}

/**
 * Normalise an archive entry path and refuse traversal. Returns null when the
 * entry must be skipped.
 */
function safeEntryPath(rawName) {
  const name = String(rawName || '').replace(/\\/g, '/')
  const withoutDrive = name.replace(/^[a-zA-Z]:/, '')
  const withoutRoot = withoutDrive.replace(/^\/+/, '')
  const parts = []
  for (const piece of withoutRoot.split('/')) {
    if (piece === '' || piece === '.') continue
    if (piece === '..') return null
    parts.push(piece)
  }
  return parts.length ? parts.join('/') : null
}

function joinUrl(base, path) {
  return trimSlash(base) + '/' + String(path || '').replace(/^\/+/, '')
}

function encodePath(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** Run `fn` over `items` with a bounded number of parallel workers. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

// ── http ────────────────────────────────────────────────────────────────────

/**
 * One HTTP request with a timeout that also honours the caller's abort signal.
 * `AbortSignal.any` lets a single fetch obey both budgets without a manual race.
 */
function combineSignals(signal, timeoutMs) {
  const signals = []
  if (signal) signals.push(signal)
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (!signals.length) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

async function request(url, options = {}) {
  const { timeoutMs = 15000, signal, headers, method = 'GET', body } = options
  const response = await fetch(url, {
    method,
    body,
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'dsh-skill-hub',
      ...(headers || {})
    },
    signal: combineSignals(signal, timeoutMs),
    redirect: 'follow'
  })
  return response
}

async function getJson(url, options = {}) {
  const response = await request(url, options)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status} for ${url}: ${clampText(text, 180)}`)
  }
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Malformed JSON from ${url}: ${clampText(text, 180)}`)
  }
}

async function getText(url, options = {}, maxChars = MAX_README_CHARS) {
  const response = await request(url, {
    ...options,
    headers: { accept: 'text/plain, text/markdown, */*', ...(options.headers || {}) }
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  const text = await response.text()
  return clampText(text, maxChars)
}

async function getBuffer(url, options = {}) {
  const response = await request(url, {
    ...options,
    timeoutMs: options.timeoutMs || 60000,
    headers: { accept: 'application/zip, application/octet-stream, */*', ...(options.headers || {}) }
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Refusing ${declared} byte download for ${url}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Refusing ${buffer.length} byte download for ${url}`)
  }
  return buffer
}

// ── zip ─────────────────────────────────────────────────────────────────────

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50

/**
 * Read the central directory and return every entry with its payload resolved.
 *
 * The central directory is used rather than walking local headers because a
 * streamed archive stores its real sizes in a trailing data descriptor while
 * the central directory always carries them.
 */
function readZipEntries(zipBuffer) {
  const searchFrom = Math.max(0, zipBuffer.length - 22 - 0xffff)
  let eocd = -1
  for (let offset = zipBuffer.length - 22; offset >= searchFrom; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('archive is not a zip file (no end of central directory record)')

  const entryCount = zipBuffer.readUInt16LE(eocd + 10)
  const centralOffset = zipBuffer.readUInt32LE(eocd + 16)

  const entries = []
  const skipped = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > zipBuffer.length) break
    if (zipBuffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) break

    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10)
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24)
    const nameLength = zipBuffer.readUInt16LE(cursor + 28)
    const extraLength = zipBuffer.readUInt16LE(cursor + 30)
    const commentLength = zipBuffer.readUInt16LE(cursor + 32)
    const localOffset = zipBuffer.readUInt32LE(cursor + 42)
    const rawName = zipBuffer.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    cursor += 46 + nameLength + extraLength + commentLength

    if (rawName.endsWith('/')) continue

    const safeName = safeEntryPath(rawName)
    if (!safeName) {
      skipped.push(rawName)
      continue
    }

    if (localOffset + 30 > zipBuffer.length) {
      skipped.push(rawName)
      continue
    }
    if (zipBuffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      skipped.push(rawName)
      continue
    }
    const localNameLength = zipBuffer.readUInt16LE(localOffset + 26)
    const localExtraLength = zipBuffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > zipBuffer.length) {
      skipped.push(rawName)
      continue
    }

    const raw = zipBuffer.slice(dataStart, dataEnd)
    let payload
    try {
      if (compressionMethod === 0) {
        payload = raw
      } else if (compressionMethod === 8) {
        payload = inflateRawSync(raw)
      } else {
        skipped.push(rawName)
        continue
      }
    } catch {
      skipped.push(rawName)
      continue
    }
    if (payload.length !== uncompressedSize) {
      skipped.push(rawName)
      continue
    }

    entries.push({ name: safeName, data: payload })
  }

  return { entries, skipped }
}

function writeEntries(entries, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  let written = 0
  for (const entry of entries) {
    const destination = join(targetDir, entry.name)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, entry.data)
    written += 1
  }
  return written
}

function extractZip(zipBuffer, targetDir) {
  const { entries, skipped } = readZipEntries(zipBuffer)
  const written = writeEntries(entries, targetDir)
  if (!written) {
    throw new Error(`archive contained no extractable files (skipped ${skipped.length})`)
  }
  return written
}

// ── local skills ────────────────────────────────────────────────────────────

function resolveSkillsDir(config) {
  if (config && config.localSkillsDir) return resolve(String(config.localSkillsDir))
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'skills')
}

/** Minimal `---` frontmatter reader — supports one level of nesting. */
function parseFrontmatter(text) {
  const source = String(text || '')
  if (!source.startsWith('---')) return {}
  const end = source.indexOf('\n---', 3)
  if (end < 0) return {}

  const result = {}
  let nestedKey = null
  for (const rawLine of source.slice(3, end).split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    const indented = /^\s+/.test(line)
    const separator = line.indexOf(':')
    if (separator < 0) continue

    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (!key) continue
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
    else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1)

    if (indented && nestedKey) {
      const bucket = result[nestedKey]
      if (bucket && typeof bucket === 'object') bucket[key] = value
      continue
    }

    if (!value) {
      nestedKey = key
      result[key] = {}
      continue
    }
    nestedKey = null
    result[key] = value
  }
  return result
}

function listLocalSkills(skillsDir) {
  const found = []
  if (!existsSync(skillsDir)) return found

  for (const entry of readdirSync(skillsDir)) {
    const dir = join(skillsDir, entry)
    const manifest = join(dir, 'SKILL.md')
    if (!existsSync(manifest)) continue

    let meta = {}
    let content = ''
    try {
      content = readFileSync(manifest, 'utf8')
      meta = parseFrontmatter(content)
    } catch {
      meta = {}
    }

    found.push({
      slug: entry,
      dirName: entry,
      name: meta.name || entry,
      summary: meta.description || '',
      summaryZh: '',
      whenToUse: meta.whenToUse || meta.when_to_use || '',
      version: (meta.metadata && meta.metadata.version) || meta.version || '',
      author: (meta.metadata && meta.metadata.author) || meta.author || '',
      license: meta.license || '',
      installed: true,
      source: 'local',
      dir
    })
  }
  return found
}

function readSkillManifest(skillsDir, slug, fileName) {
  if (!existsSync(skillsDir)) return null
  const safeSlug = safeSkillDirName(slug)
  if (!safeSlug) return null

  let targetDir = join(skillsDir, safeSlug)
  if (!existsSync(targetDir)) {
    const lower = safeSlug.toLowerCase()
    const match = readdirSync(skillsDir).find((entry) => entry.toLowerCase() === lower)
    if (!match) return null
    targetDir = join(skillsDir, match)
  }

  const requested =
    fileName && !/[/\\]/.test(String(fileName)) && String(fileName) !== '..' ? String(fileName) : ''
  const candidates = requested ? [requested, 'SKILL.md', 'README.md'] : ['SKILL.md', 'README.md']

  for (const candidate of candidates) {
    const path = join(targetDir, candidate)
    if (!existsSync(path)) continue
    try {
      if (!statSync(path).isFile()) continue
      return { fileName: candidate, content: readFileSync(path, 'utf8'), dir: targetDir }
    } catch {
      continue
    }
  }
  return null
}

// ── categories ──────────────────────────────────────────────────────────────

let categoryCache = { at: 0, list: [] }

function normalizeCategories(rawItems) {
  const list = []
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const key = typeof item === 'string' ? item : item && item.key
    if (!key) continue
    if (HIDDEN_CATEGORY_KEYS.has(key)) continue
    const english = (item && (item.nameEn || item.name)) || key
    list.push({
      key,
      name: CATEGORY_ZH[key] || english,
      nameEn: english,
      sortOrder: Number((item && item.sortOrder) || 0)
    })
  }
  list.sort((a, b) => a.sortOrder - b.sortOrder)
  return list
}

async function loadCategories(config, signal) {
  const fresh = Date.now() - categoryCache.at < config.cacheTtlMs
  if (fresh && categoryCache.list.length) return categoryCache.list

  try {
    const payload = await getJson(joinUrl(config.skillhubApiBase, '/api/v1/categories'), {
      timeoutMs: config.sourceTimeoutMs,
      signal
    })
    const raw = payload.items || payload.data || []
    const list = normalizeCategories(raw)
    if (list.length) {
      categoryCache = { at: Date.now(), list }
      return list
    }
  } catch {
    // fall through to the built-in catalogue so the filter is never empty
  }

  const fallback = Object.keys(CATEGORY_ZH)
    .filter((key) => !HIDDEN_CATEGORY_KEYS.has(key))
    .map((key, index) => ({
      key,
      name: CATEGORY_ZH[key],
      nameEn: key,
      sortOrder: index
    }))
  return fallback
}

// ── source: SkillHub ────────────────────────────────────────────────────────

const skillhub = {
  id: 'skillhub',
  label: 'SkillHub',
  supportsCategory: true,

  async search(config, args, signal) {
    const page = toPositiveInt(args.page, 1, 200)
    const pageSize = toPositiveInt(args.pageSize, 30, 100)
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortBy: 'downloads',
      order: 'desc'
    })
    if (args.keyword) params.set('keyword', String(args.keyword))
    if (args.category) params.set('category', String(args.category))

    const payload = await getJson(
      joinUrl(config.skillhubApiBase, '/api/skills') + '?' + params.toString(),
      { timeoutMs: config.sourceTimeoutMs, signal }
    )
    const rows = (payload.data && payload.data.skills) || []
    const total = Number((payload.data && payload.data.total) || 0)

    const installName = new Set(listLocalSkills(resolveSkillsDir(config)).map((s) => s.slug.toLowerCase()))

    const items = rows.map((row) => ({
      // Two publishers may reuse one slug, so the per-publisher namespace is
      // part of the row identity. Without it a page that shows both would hand
      // React two children with the same key, and cards would be duplicated or
      // dropped on re-render.
      id: 'skillhub:' + ((row.namespace && row.namespace.canonicalName) || row.slug),
      source: 'skillhub',
      sourceLabel: 'SkillHub',
      slug: row.slug,
      owner: row.ownerName || '',
      name: row.name || row.displayName || row.slug,
      summary: row.description || row.summary || '',
      summaryZh: row.description_zh || '',
      version: row.version || '',
      iconUrl: row.iconUrl || '',
      downloads: Number(row.downloads || 0),
      stars: Number(row.stars || 0),
      verified: !!row.verified,
      category: row.category || '',
      tags: Array.isArray(row.tags) ? row.tags.slice(0, 6) : [],
      homepage: row.homepage || '',
      // Identity for de-duplication. `upstreamUrl` marks an entry SkillHub
      // mirrors from another registry (currently ClawHub); `namespaceKey` is
      // SkillHub's own per-publisher identity, which keeps two publishers who
      // happen to reuse the same slug as two separate skills.
      upstreamUrl: row.upstream_url || '',
      namespaceKey: (row.namespace && row.namespace.canonicalName) || '',
      installed: installName.has(String(row.slug).toLowerCase())
    }))

    return { items, total, hasMore: page * pageSize < total }
  },

  async detail(config, ref, signal) {
    const slug = String(ref.slug || '')
    const payload = await getJson(joinUrl(config.skillhubApiBase, '/api/v1/skills/batch'), {
      method: 'POST',
      timeoutMs: config.sourceTimeoutMs,
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slugs: [slug] })
    })
    const item = (payload.items || [])[0]
    if (!item || !item.skill) throw new Error(`SkillHub has no skill named "${slug}"`)

    const skill = item.skill
    const version = item.latestVersion || {}
    const stats = skill.stats || {}

    return {
      id: 'skillhub:' + slug,
      source: 'skillhub',
      sourceLabel: 'SkillHub',
      slug,
      owner: (item.owner && item.owner.handle) || '',
      ownerName: (item.owner && item.owner.displayName) || '',
      name: skill.displayName || skill.slug || slug,
      summary: skill.summary || '',
      summaryZh: skill.summary_zh || '',
      version: version.version || '',
      changelog: version.changelog || '',
      updatedAt: skill.updatedAt || version.createdAt || 0,
      iconUrl: skill.iconUrl || '',
      downloadCount: Number(stats.downloads || 0),
      stars: Number(stats.stars || 0),
      installs: Number(stats.installs || 0),
      versions: Number(stats.versions || 0),
      verified: !!skill.verified,
      category: skill.category || '',
      tags: Array.isArray(skill.tags) ? skill.tags : [],
      license: (skill.ext && skill.ext.license) || '',
      homepage: (skill.sourceUrl || skill.upstream_url || ''),
      security: Array.isArray(item.securityReports)
        ? item.securityReports.map((report) => ({
            level: report.riskLevel || report.level || '',
            summary: report.summary || report.title || ''
          }))
        : []
    }
  },

  async readme(config, ref, signal) {
    const slug = String(ref.slug || '')
    const path = '/api/v1/skills/' + encodeURIComponent(slug) + '/file?path=SKILL.md'
    const content = await getText(joinUrl(config.skillhubApiBase, path), {
      timeoutMs: config.sourceTimeoutMs,
      signal
    })
    return { fileName: 'SKILL.md', content }
  },

  async install(config, ref, signal) {
    const slug = String(ref.slug || '')
    const params = new URLSearchParams({ slug })
    try {
      return await getBuffer(
        joinUrl(config.skillhubApiBase, '/api/v1/download') + '?' + params.toString(),
        { timeoutMs: config.downloadTimeoutMs, signal }
      )
    } catch (error) {
      if (isAbort(error) && signal && signal.aborted) throw error
      // Some catalogue entries (the older "enterprise" ones) have no archive
      // even though the skill itself is complete. The file listing is still
      // authoritative, so fetch it file by file instead of refusing to install.
      return fetchSkillHubFiles(config, slug, signal)
    }
  }
}

/**
 * Install a SkillHub skill from its file listing when no archive exists.
 * Returns the same `{ entries, skipped }` shape the zip path produces, so the
 * caller does not need a second install pipeline.
 */
async function fetchSkillHubFiles(config, slug, signal) {
  const base = joinUrl(config.skillhubApiBase, '/api/v1/skills/' + encodeURIComponent(slug))
  const listing = await getJson(base + '/files', { timeoutMs: config.sourceTimeoutMs, signal })
  const files = Array.isArray(listing.files) ? listing.files : []
  if (!files.length) throw new Error(`SkillHub lists no files for "${slug}"`)

  const entries = []
  const skipped = []
  await mapLimit(files, 4, async (file) => {
    const raw = String((file && file.path) || '')
    const name = safeEntryPath(raw)
    if (!name) {
      skipped.push(raw)
      return
    }
    try {
      const data = await getBuffer(base + '/file?path=' + encodeURIComponent(raw), {
        timeoutMs: config.downloadTimeoutMs,
        signal
      })
      entries.push({ name, data })
    } catch (error) {
      if (isAbort(error) && signal && signal.aborted) throw error
      skipped.push(raw)
    }
  })
  if (!entries.length) throw new Error(`SkillHub file download failed for "${slug}"`)
  return { entries, skipped }
}

// ── source: ClawHub ─────────────────────────────────────────────────────────

const clawhub = {
  id: 'clawhub',
  label: 'ClawHub',
  supportsCategory: false,

  async search(config, args, signal) {
    const pageSize = toPositiveInt(args.pageSize, 24, 50)
    const keyword = String(args.keyword || '').trim()

    // /api/v1/search returns nothing at all for an empty query, but the
    // catalogue still has to be browsable with no keyword. /api/v1/skills is
    // the browse endpoint: same item shape, cursor-paged, and it actually
    // answers when q is absent. Use it for the empty-query case only, so a
    // real search keeps matching on relevance.
    //
    // The browse endpoint ignores `limit` on its default ordering and hands
    // back an arbitrary slice (measured: 5, 28 or 73 rows for limit=50, and
    // the count changes between calls). Passing an explicit sort makes it
    // honour the limit and page deterministically — `sort=downloads` returned
    // a stable 50 rows across repeats with no overlap between cursor pages.
    const useBrowse = !keyword
    const params = new URLSearchParams({ limit: String(pageSize) })
    if (useBrowse) {
      params.set('sort', 'downloads')
      if (args.cursor) params.set('cursor', String(args.cursor))
    } else {
      params.set('q', keyword)
    }

    const payload = await getJson(
      joinUrl(config.clawhubApiBase, useBrowse ? '/api/v1/skills' : '/api/v1/search') +
        '?' +
        params.toString(),
      { timeoutMs: config.sourceTimeoutMs, signal }
    )
    const rows = payload.results || payload.items || []
    const installName = new Set(listLocalSkills(resolveSkillsDir(config)).map((s) => s.slug.toLowerCase()))

    const items = rows.map((row) => {
      const metrics = row.metrics || {}
      const stats = row.stats || {}
      const owner = row.ownerHandle || (row.owner && row.owner.handle) || ''
      const slug = row.slug || ''
      return {
        id: 'clawhub:' + owner + '/' + slug,
        source: 'clawhub',
        sourceLabel: 'ClawHub',
        slug,
        owner,
        name: row.displayName || slug,
        summary: row.summary || row.description || '',
        summaryZh: '',
        version: row.version || (row.latestVersion && row.latestVersion.version) || '',
        iconUrl: row.icon || '',
        downloads: Number(
          row.downloads || stats.downloads || metrics.rolling60DayInstalls || 0
        ),
        stars: Number(stats.stars || metrics.bookmarks || 0),
        verified: !!(row.publisher && row.publisher.official) || row.official === true,
        category: '',
        tags: Array.isArray(row.topics) ? row.topics.slice(0, 6) : [],
        homepage: '',
        // ClawHub's own identity is owner/slug: a bare slug is not unique
        // across publishers, so de-duplication keys off both parts.
        namespaceKey: owner ? owner + '/' + slug : '',
        installed: installName.has(slug.toLowerCase())
      }
    })

    return {
      items,
      total: items.length,
      // The browse endpoint hands back an opaque cursor; treat it as the
      // "there is more" signal so the UI can offer the next page.
      cursor: useBrowse ? payload.nextCursor || null : null,
      hasMore: useBrowse ? !!payload.nextCursor : false
    }
  },

  async detail(config, ref, signal) {
    const slug = String(ref.slug || '')
    const params = new URLSearchParams()
    if (ref.owner) params.set('ownerHandle', String(ref.owner))
    const suffix = params.toString() ? '?' + params.toString() : ''

    const payload = await getJson(
      joinUrl(config.clawhubApiBase, '/api/v1/skills/' + encodeURIComponent(slug)) + suffix,
      { timeoutMs: config.sourceTimeoutMs, signal }
    )
    const skill = payload.skill || {}
    const version = payload.latestVersion || {}
    const stats = skill.stats || {}

    return {
      id: 'clawhub:' + (ref.owner || '') + '/' + slug,
      source: 'clawhub',
      sourceLabel: 'ClawHub',
      slug,
      owner: (payload.owner && payload.owner.handle) || ref.owner || '',
      ownerName: (payload.owner && payload.owner.displayName) || '',
      name: skill.displayName || slug,
      summary: skill.summary || skill.description || '',
      summaryZh: '',
      version: version.version || '',
      changelog: version.changelog || '',
      updatedAt: skill.updatedAt || 0,
      license: version.license || '',
      iconUrl: skill.icon || '',
      downloadCount: Number(stats.downloads || stats.installs || 0),
      stars: Number(stats.stars || stats.bookmarks || 0),
      category: '',
      tags: Array.isArray(skill.topics) ? skill.topics : [],
      homepage: '',
      security: []
    }
  },

  async readme(config, ref, signal) {
    const slug = String(ref.slug || '')
    const params = new URLSearchParams({ path: 'SKILL.md' })
    if (ref.owner) params.set('ownerHandle', String(ref.owner))
    const content = await getText(
      joinUrl(config.clawhubApiBase, '/api/v1/skills/' + encodeURIComponent(slug) + '/file') +
        '?' +
        params.toString(),
      { timeoutMs: config.sourceTimeoutMs, signal }
    )
    return { fileName: 'SKILL.md', content }
  },

  async install(config, ref, signal) {
    const params = new URLSearchParams({ slug: String(ref.slug || '') })
    if (ref.owner) params.set('ownerHandle', String(ref.owner))
    return getBuffer(
      joinUrl(config.clawhubApiBase, '/api/v1/download') + '?' + params.toString(),
      { timeoutMs: config.downloadTimeoutMs, signal }
    )
  }
}

// ── source: GitHub (through jsDelivr, no GitHub quota) ──────────────────────

/** Cached file trees so browsing a repo costs one request per TTL window. */
const treeCache = new Map()

function parseRepoRef(spec) {
  const text = String(spec || '').trim()
  if (!text) return null
  const [repoPart, refPart] = text.split('@')
  const [owner, repo] = repoPart.split('/')
  if (!owner || !repo) return null
  return { owner, repo, ref: refPart || 'main', spec: text }
}

function parseRepoList(value) {
  const list = String(value || '')
    .split(',')
    .map((piece) => parseRepoRef(piece))
    .filter(Boolean)
  return list.length ? list : String(DEFAULT_GITHUB_REPOS).split(',').map(parseRepoRef).filter(Boolean)
}

/**
 * Mirror hosts, in the order they should be tried. Accepts a list or a
 * comma/space separated string. The older single-host `skillhubApiBase` setting
 * still works: when it is set it becomes the only mirror, so an existing
 * configuration keeps pointing where its owner put it.
 */
function parseMirrorList(value, legacyBase) {
  const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : ''
  const list = raw
    .split(/[\s,]+/)
    .map((piece) => trimSlash(piece.trim()))
    .filter((piece) => /^https?:\/\//i.test(piece))
  if (list.length) return list
  const legacy = trimSlash(legacyBase || '')
  if (legacy) return [legacy]
  return DEFAULT_SKILLHUB_MIRRORS.slice()
}

/** jsDelivr's own file listing. Fast and quota-free, but it refuses some repos. */
async function listViaJsdelivr(config, repoSpec, signal) {
  const url =
    joinUrl(config.jsdelivrDataApi, '/v1/packages/gh') +
    '/' +
    encodeURIComponent(repoSpec.owner) +
    '/' +
    encodeURIComponent(repoSpec.repo) +
    '@' +
    encodeURIComponent(repoSpec.ref) +
    '?structure=flat'

  const payload = await getJson(url, { timeoutMs: config.sourceTimeoutMs, signal })
  const files = (payload.files || [])
    .map((entry) => entry && entry.name)
    .filter((entry) => typeof entry === 'string')
  // A listing with no SKILL.md anywhere is almost certainly a truncated or
  // partial answer rather than a repo that genuinely has none.
  if (!files.some((file) => /\/SKILL\.md$/i.test(file))) {
    throw new Error('jsDelivr listing contained no SKILL.md')
  }
  return files
}

/**
 * GitHub's git/trees API. Costs one request against the 60/hour unauthenticated
 * quota, so it is only the fallback — but it is authoritative, and it accepts a
 * `githubToken` for anyone who needs more headroom.
 */
async function listViaGithub(config, repoSpec, signal) {
  const url =
    joinUrl(config.githubApiBase, '/repos') +
    '/' +
    encodeURIComponent(repoSpec.owner) +
    '/' +
    encodeURIComponent(repoSpec.repo) +
    '/git/trees/' +
    encodeURIComponent(repoSpec.ref) +
    '?recursive=1'

  const headers = { accept: 'application/vnd.github+json' }
  if (config.githubToken) headers.authorization = 'Bearer ' + config.githubToken

  const payload = await getJson(url, { timeoutMs: config.sourceTimeoutMs, signal, headers })
  const files = (payload.tree || [])
    .filter((entry) => entry && entry.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => '/' + entry.path)

  if (payload.truncated) {
    // Better a partial catalogue than none, but say so in the tree itself.
    files.truncated = true
  }
  return files
}

/**
 * GitHub first, jsDelivr second — the opposite of what you would guess.
 *
 * jsDelivr's listing is faster and costs no quota, but it silently caps how many
 * files it returns (ComposioHQ's ~860 skills come back as 309 files / 32
 * SKILL.md). A truncated catalogue is indistinguishable from a small one from the
 * outside, so a "completeness check" cannot catch it. git/trees is authoritative,
 * so it goes first; jsDelivr only covers the case where the 60/hour anonymous
 * quota is exhausted.
 */
async function loadTree(config, repoSpec, signal) {
  const cacheKey = repoSpec.spec
  const cached = treeCache.get(cacheKey)
  if (cached && Date.now() - cached.at < config.cacheTtlMs) return cached.files

  let files
  let via = 'github'
  try {
    files = await listViaGithub(config, repoSpec, signal)
  } catch (error) {
    if (isAbort(error) && signal && signal.aborted) throw error
    files = await listViaJsdelivr(config, repoSpec, signal)
    via = 'jsdelivr'
  }

  treeCache.set(cacheKey, { at: Date.now(), files, via })
  return files
}

/**
 * Some catalogues prefix their folders with ordering artefacts (`-21risk-automation`).
 * Strip that noise for display only — slugs stay byte-stable so installs and
 * uninstalls keep pointing at the same directory.
 */
function prettySkillName(dirName) {
  const cleaned = String(dirName || '').replace(/^[-_.\s]+/, '').replace(/[-_]+/g, ' ').trim()
  return cleaned || String(dirName || '')
}

/** Turn a flat file list into one record per `<dir>/SKILL.md`. */
function collectGithubSkills(files, repoSpec) {
  const skills = []
  for (const path of files) {
    if (!/^\/?(.+)\/SKILL\.md$/i.test(path)) continue
    const dir = path.replace(/^\/+/, '').replace(/\/SKILL\.md$/i, '')
    const segments = dir.split('/')
    const dirName = segments[segments.length - 1]
    skills.push({
      repoKey: repoSpec.owner + '/' + repoSpec.repo,
      repoRef: repoSpec.ref,
      path: dir,
      dirName,
      displayName: prettySkillName(dirName),
      // Install directory name must be a single safe segment and unique across repos.
      slug: (repoSpec.repo + '-' + dirName).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '')
    })
  }
  return skills
}

function githubRawUrl(config, repoSpec, path) {
  // Build from the trimmed base rather than joining with '/': joinUrl strips
  // leading slashes from the second argument, so passing '/' produced a bare
  // separator and the trailing '/' below became a second one
  // (raw.githubusercontent.com//owner/...), which some edges reject.
  return (
    trimSlash(config.githubRawBase) +
    '/' +
    encodeURIComponent(repoSpec.owner) +
    '/' +
    encodeURIComponent(repoSpec.repo) +
    '/' +
    encodeURIComponent(repoSpec.ref) +
    '/' +
    encodePath(path)
  )
}

function githubCdnUrl(config, repoSpec, path) {
  return (
    joinUrl(config.jsdelivrCdn, '/gh') +
    '/' +
    encodeURIComponent(repoSpec.owner) +
    '/' +
    encodeURIComponent(repoSpec.repo) +
    '@' +
    encodeURIComponent(repoSpec.ref) +
    '/' +
    encodePath(path)
  )
}

/**
 * File bodies come from raw.githubusercontent.com, then jsDelivr.
 *
 * Measured against the same 8 KB file: raw answered in 104-1135 ms every round,
 * while the jsDelivr CDN took 2.8 s once and timed out past 9 s another time. The
 * CDN is a nice cache but an unreliable primary, and raw costs no API quota.
 */
async function getGithubFile(config, repoSpec, path, options) {
  const primary = githubRawUrl(config, repoSpec, path)
  try {
    return await getBuffer(primary, options)
  } catch (error) {
    if (isAbort(error) && options && options.signal && options.signal.aborted) throw error
    return await getBuffer(githubCdnUrl(config, repoSpec, path), options)
  }
}

const github = {
  id: 'github',
  label: 'GitHub',
  supportsCategory: false,

  async search(config, args, signal) {
    const repos = config.githubRepos
    if (!repos.length) return { items: [], total: 0, hasMore: false }

    const page = toPositiveInt(args.page, 1, 200)
    const pageSize = toPositiveInt(args.pageSize, 24, 60)
    const keyword = String(args.keyword || '').trim().toLowerCase()

    const perRepo = await Promise.all(
      repos.map(async (repoSpec, repoRank) => {
        try {
          const files = await loadTree(config, repoSpec, signal)
          // repoRank keeps the curated author catalogues ahead of bulk mirrors,
          // matching the order in DEFAULT_GITHUB_REPOS / the `githubRepos` config.
          return collectGithubSkills(files, repoSpec).map((entry) => ({ ...entry, repoSpec, repoRank }))
        } catch {
          return []
        }
      })
    )

    let flattened = perRepo.flat()

    // Several catalogues carry copies of the same skill (ComposioHQ re-ships the
    // upstream set at its root). Keep the first occurrence so the author wins over
    // the mirror, and the list reads as one skill rather than two.
    //
    // The key is the display name with punctuation folded away, not the directory
    // name: some upstream repos ship the same skill as both `docker-hub-automation`
    // and `docker_hub-automation`, which are distinct directories but render as two
    // identical cards. Folding `-` and `_` collapses those into one entry.
    const dedupeKey = (entry) =>
      String(entry.displayName || entry.dirName || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    const seenNames = new Set()
    flattened = flattened.filter((entry) => {
      const key = dedupeKey(entry) || entry.dirName.toLowerCase()
      if (seenNames.has(key)) return false
      seenNames.add(key)
      return true
    })

    if (keyword) {
      flattened = flattened.filter(
        (entry) =>
          entry.dirName.toLowerCase().includes(keyword) ||
          entry.path.toLowerCase().includes(keyword) ||
          entry.repoKey.toLowerCase().includes(keyword)
      )
    }

    flattened.sort(
      (a, b) => a.repoRank - b.repoRank || a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')
    )
    const total = flattened.length
    const start = (page - 1) * pageSize
    const slice = flattened.slice(start, start + pageSize)

    const installName = new Set(listLocalSkills(resolveSkillsDir(config)).map((s) => s.slug.toLowerCase()))

    const items = slice.map((entry) => ({
      id: 'github:' + entry.repoKey + '/' + entry.path,
      source: 'github',
      sourceLabel: 'GitHub',
      slug: entry.slug,
      owner: entry.repoKey,
      ownerName: entry.repoKey,
      repoRef: entry.repoRef,
      repoPath: entry.path,
      name: entry.displayName,
      summary: '',
      summaryZh: '',
      version: '',
      iconUrl: '',
      downloads: 0,
      stars: 0,
      verified: false,
      category: '',
      tags: [],
      homepage: 'https://github.com/' + entry.repoKey + '/tree/' + entry.repoRef + '/' + entry.path,
      // A GitHub skill's canonical identity is repo + directory: two repos can
      // both ship a `code-review` directory without being the same skill.
      namespaceKey: entry.repoKey + '/' + entry.path,
      installed: installName.has(entry.slug)
    }))

    return { items, total, hasMore: start + slice.length < total }
  },

  async detail(config, ref, signal) {
    const repoSpec = parseRepoRef(ref.owner + '@' + (ref.repoRef || 'main'))
    if (!repoSpec) throw new Error(`Malformed GitHub reference "${ref.owner}"`)
    const path = String(ref.repoPath || '')
    if (!path) throw new Error('GitHub reference is missing repoPath')

    const content = await getGithubFile(config, repoSpec, path + '/SKILL.md', {
      timeoutMs: config.sourceTimeoutMs,
      signal
    })
    const text = content.toString('utf8')
    const meta = parseFrontmatter(text)
    const dirName = path.split('/').pop()

    return {
      id: 'github:' + ref.owner + '/' + path,
      source: 'github',
      sourceLabel: 'GitHub',
      slug: (repoSpec.repo + '-' + dirName).toLowerCase(),
      owner: repoSpec.owner + '/' + repoSpec.repo,
      ownerName: repoSpec.owner + '/' + repoSpec.repo,
      repoRef: repoSpec.ref,
      repoPath: path,
      name: meta.name || dirName,
      summary: meta.description || '',
      summaryZh: '',
      whenToUse: meta.whenToUse || meta.when_to_use || '',
      version: (meta.metadata && meta.metadata.version) || meta.version || '',
      license: meta.license || '',
      updatedAt: 0,
      iconUrl: '',
      downloadCount: 0,
      stars: 0,
      category: '',
      tags: [],
      homepage:
        'https://github.com/' + repoSpec.owner + '/' + repoSpec.repo + '/tree/' + repoSpec.ref + '/' + path,
      security: [],
      readme: text
    }
  },

  async readme(config, ref, signal) {
    const repoSpec = parseRepoRef(ref.owner + '@' + (ref.repoRef || 'main'))
    if (!repoSpec) throw new Error(`Malformed GitHub reference "${ref.owner}"`)
    const buffer = await getGithubFile(config, repoSpec, String(ref.repoPath || '') + '/SKILL.md', {
      timeoutMs: config.sourceTimeoutMs,
      signal
    })
    return { fileName: 'SKILL.md', content: buffer.toString('utf8') }
  },

  /** Download every file under the skill directory and hand back a file map. */
  async install(config, ref, signal) {
    const repoSpec = parseRepoRef(ref.owner + '@' + (ref.repoRef || 'main'))
    if (!repoSpec) throw new Error(`Malformed GitHub reference "${ref.owner}"`)
    const path = String(ref.repoPath || '')
    if (!path) throw new Error('GitHub reference is missing repoPath')

    const files = await loadTree(config, repoSpec, signal)
    const prefix = '/' + path + '/'
    const wanted = files.filter((file) => file.startsWith(prefix) && !file.endsWith('/'))
    if (!wanted.length) throw new Error(`No files under "${path}" in ${ref.owner}`)

    const skipped = []
    const downloaded = await mapLimit(wanted, 6, async (file) => {
      const relative = file.slice(prefix.length)
      try {
        const buffer = await getGithubFile(config, repoSpec, path + '/' + relative, {
          timeoutMs: config.downloadTimeoutMs,
          signal
        })
        return { name: relative, data: buffer }
      } catch (error) {
        if (isAbort(error) && signal && signal.aborted) throw error
        // The tree is a snapshot of the branch, so a file it still lists may already
        // be gone upstream (renamed or deleted). One stale entry must not sink the
        // install; SKILL.md is checked below.
        skipped.push({ name: relative, reason: clampText(error && error.message, 120) })
        return null
      }
    })

    const present = downloaded.filter(Boolean)
    if (!present.some((entry) => entry.name === 'SKILL.md')) {
      throw new Error(
        `Could not fetch SKILL.md from ${ref.owner}/${path}` +
          (skipped.length
            ? ` (${skipped.length} unavailable file(s): ${skipped.slice(0, 3).map((s) => s.name).join(', ')})`
            : '')
      )
    }

    return { entries: present, skipped }
  }
}

// ── experts ─────────────────────────────────────────────────────────────────

/**
 * Read one roster document.
 *
 * The route order here is measured, not guessed. On a mainland connection
 * raw.githubusercontent.com timed out after 20s and cdn.jsdelivr.net answered
 * in 17-20s, while the contents API answered in 0.9s. The roster is two small
 * documents, so the API goes first; the plain-text hosts stay as the fallback
 * for networks where the API is blocked or its quota is spent.
 */
async function getExpertFile(config, repoSpec, path, options = {}) {
  const apiUrl =
    trimSlash(config.githubApiBase) +
    '/repos/' +
    encodeURIComponent(repoSpec.owner) +
    '/' +
    encodeURIComponent(repoSpec.repo) +
    '/contents/' +
    encodePath(path) +
    '?ref=' +
    encodeURIComponent(repoSpec.ref)
  const headers = { accept: 'application/vnd.github.raw' }
  if (config.githubToken) headers.authorization = 'Bearer ' + config.githubToken

  let lastError
  for (const attempt of [
    () => getBuffer(apiUrl, { ...options, headers }),
    () => getGithubFile(config, repoSpec, path, options)
  ]) {
    try {
      return await attempt()
    } catch (error) {
      if (isAbort(error) && options.signal && options.signal.aborted) throw error
      lastError = error
    }
  }
  throw lastError
}

/**
 * `## 🛠️ 工程部 (75)` followed by `| 中文名 | `engineering/foo.md` |` rows.
 * The department key is taken from the folder the files live in, because the
 * headings themselves are Chinese and a folder name is what the UI can filter
 * on without carrying a translation table.
 */
function parseExpertCatalog(text) {
  const departments = []
  const experts = []
  let current = null

  for (const line of String(text || '').split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      const raw = heading[1]
      const counted = raw.match(/^(.*?)\s*\((\d+)\)\s*$/)
      const title = counted ? counted[1] : raw
      current = {
        key: '',
        label: title.replace(/^[^\p{L}\p{N}]+/u, '').trim(),
        emoji: (title.match(/^[^\p{L}\p{N}]+/u) || [''])[0].trim(),
        count: counted ? Number(counted[2]) : 0,
        experts: []
      }
      departments.push(current)
      continue
    }

    const row = line.match(/^\|\s*(.+?)\s*\|\s*`([^`]+\.md)`\s*\|$/)
    if (!row || !current) continue
    const path = row[2]
    if (!current.key) current.key = path.includes('/') ? path.split('/')[0] : ''
    current.experts.push({
      stem: path.split('/').pop().replace(/\.md$/i, ''),
      name: row[1].trim(),
      path
    })
  }

  for (const department of departments) {
    for (const expert of department.experts) {
      expert.deptKey = department.key
      expert.deptLabel = department.label
      expert.emoji = department.emoji
      experts.push(expert)
    }
  }

  return { departments: departments.filter((item) => item.experts.length), experts }
}

/** `| \`agent-id\` | 中文名 | 一句话简介 | 来源 |` */
function parseExpertRoster(text) {
  const blurbs = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const row = line.match(/^\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|/)
    if (!row) continue
    blurbs.set(row[1].trim(), row[3].trim())
  }
  return blurbs
}

let expertCache = { key: '', at: 0, value: null }

async function loadExpertCatalog(config, signal) {
  const repoSpec = parseRepoRef(config.expertsRepo)
  if (!repoSpec) throw new Error(`Malformed experts repo "${config.expertsRepo}"`)
  const key = repoSpec.owner + '/' + repoSpec.repo + '@' + repoSpec.ref
  if (expertCache.value && expertCache.key === key && Date.now() - expertCache.at < config.cacheTtlMs) {
    return expertCache.value
  }

  const options = { timeoutMs: config.sourceTimeoutMs, signal }
  const [catalogText, rosterText] = await Promise.all([
    getExpertFile(config, repoSpec, DEFAULT_EXPERTS_CATALOG, options).then((buffer) => buffer.toString('utf8')),
    // The blurb is a nicety: a roster that fails to load still leaves a usable
    // picker, so it must never take the catalog down with it.
    getExpertFile(config, repoSpec, DEFAULT_EXPERTS_ROSTER, options)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => '')
  ])

  const parsed = parseExpertCatalog(catalogText)
  const blurbs = parseExpertRoster(rosterText)
  for (const expert of parsed.experts) expert.summary = blurbs.get(expert.stem) || ''

  const value = {
    repo: repoSpec.owner + '/' + repoSpec.repo,
    ref: repoSpec.ref,
    departments: parsed.departments,
    experts: parsed.experts,
    total: parsed.experts.length
  }
  expertCache = { key, at: Date.now(), value }
  return value
}

function yamlScalar(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  if (!text) return '""'
  const plain = /^[A-Za-z0-9\u4e00-\u9fa5][^:#"'\n]*$/.test(text)
  const reserved = /^(?:true|false|null|yes|no|on|off|~)$/i.test(text)
  return plain && !reserved ? text : JSON.stringify(text)
}

/**
 * Upstream ships each role as a persona prompt whose frontmatter carries a
 * Chinese `name:`. The harness only accepts `^[a-z0-9]+(-[a-z0-9]+)*$` as a
 * skill name and silently drops anything else, so the file is rewritten: the
 * ascii id becomes `name`, and the Chinese display name moves to the front of
 * `description`, which is where it stays visible.
 */
function buildExpertSkillMarkdown(expert, raw) {
  const text = String(raw || '')
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const body = front ? text.slice(front[0].length) : text
  const data = {}
  if (front) {
    for (const line of front[1].split(/\r?\n/)) {
      const field = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
      if (field) data[field[1]] = field[2].trim().replace(/^["']|["']$/g, '')
    }
  }

  const description = [expert.name, data.description || expert.summary || ''].filter(Boolean).join(' · ')
  const header = ['---', 'name: ' + expert.stem, 'description: ' + yamlScalar(description)]
  if (data.emoji) header.push('emoji: ' + yamlScalar(data.emoji))
  if (data.color) header.push('color: ' + yamlScalar(data.color))
  header.push('---', '')

  // The persona files already open with their own `# 标题`; only add one when
  // the body would otherwise start with nothing to identify the role.
  const trimmed = body.replace(/^\s+/, '')
  const lead = /^#{1,6}\s/.test(trimmed)
    ? ''
    : '# ' + expert.name + (expert.deptLabel ? '（' + expert.deptLabel + '）' : '') + '\n\n'
  return header.join('\n') + lead + trimmed
}

async function loadExpertDetail(config, ref, signal) {
  const repoSpec = parseRepoRef(config.expertsRepo)
  if (!repoSpec) throw new Error(`Malformed experts repo "${config.expertsRepo}"`)
  const path = String(ref.repoPath || '')
  if (!path) throw new Error('expert reference is missing repoPath')

  const buffer = await getExpertFile(config, repoSpec, path, {
    timeoutMs: config.sourceTimeoutMs,
    signal
  })
  const stem = String(ref.slug || path.split('/').pop().replace(/\.md$/i, ''))
  const catalog = await loadExpertCatalog(config, signal).catch(() => null)
  const known = catalog ? catalog.experts.find((item) => item.stem === stem) : null
  const expert = {
    stem,
    name: (known && known.name) || stem,
    deptKey: (known && known.deptKey) || '',
    deptLabel: (known && known.deptLabel) || '',
    summary: (known && known.summary) || ''
  }
  const markdown = buildExpertSkillMarkdown(expert, buffer.toString('utf8'))

  return {
    id: 'experts:' + stem,
    source: 'experts',
    sourceLabel: '专家',
    slug: stem,
    owner: repoSpec.owner + '/' + repoSpec.repo,
    ownerName: repoSpec.owner + '/' + repoSpec.repo,
    repoRef: repoSpec.ref,
    repoPath: path,
    name: expert.name,
    summary: expert.summary,
    summaryZh: expert.summary,
    whenToUse: '',
    version: '',
    license: '',
    updatedAt: 0,
    iconUrl: '',
    downloadCount: 0,
    stars: 0,
    category: expert.deptKey,
    tags: [expert.deptLabel].filter(Boolean),
    homepage:
      'https://github.com/' + repoSpec.owner + '/' + repoSpec.repo + '/blob/' + repoSpec.ref + '/' + path,
    security: [],
    readme: markdown
  }
}

const experts = {
  id: 'experts',
  label: '专家',
  supportsCategory: false,
  // A curated roster is browsed, not searched: it stays out of searchAcross and
  // is served whole by its own endpoint.
  standalone: true,

  detail(config, ref, signal) {
    return loadExpertDetail(config, ref, signal)
  },

  async readme(config, ref, signal) {
    const detail = await loadExpertDetail(config, ref, signal)
    return { fileName: 'SKILL.md', content: detail.readme }
  },

  async install(config, ref, signal) {
    const detail = await loadExpertDetail(config, ref, signal)
    return [{ name: 'SKILL.md', data: Buffer.from(detail.readme, 'utf8') }]
  }
}

// `github` and `experts` are intentionally absent from the search set: GitHub
// was the noisiest catalogue for little gain, and the expert roster is browsed
// through its own route rather than keyword search.
const SOURCES = { skillhub, clawhub, experts }

// ── aggregation ─────────────────────────────────────────────────────────────

/**
 * When two catalogues hold the same skill, the higher-ranked source wins.
 * SkillHub outranks ClawHub because it carries Chinese descriptions and a
 * mirror relationship to ClawHub.
 */
const SOURCE_RANK = { skillhub: 0, clawhub: 1 }

/** Lower-case and strip everything that only varies by formatting. */
function foldText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

/**
 * Registry names that a mirror's owner segment is prefixed with. SkillHub
 * stamps an imported row as `@clawhub_rez0/agent-browser`; the `clawhub_`
 * prefix is the registry it came from, not part of the owner's handle.
 */
const SOURCE_PREFIXES = ['clawhub_', 'skillhub_']

/** Drop a leading registry marker from an owner segment, if present. */
function stripSourcePrefix(segment) {
  for (const prefix of SOURCE_PREFIXES) {
    if (segment.startsWith(prefix)) return segment.slice(prefix.length)
  }
  return segment
}

/**
 * Fold an "owner/slug" style identity segment by segment.
 *
 * Folding the whole string would collapse the separator too, so
 * `owner/slug` and `owner-slug` would look identical — wrong, because they
 * name different things. Each part is folded and rejoined instead. A leading
 * `@` (SkillHub's canonical-name marker) and any registry prefix are removed
 * first, so a mirror's namespace lines up with the identity it mirrors.
 */
function normalizeIdentity(value) {
  const parts = String(value || '')
    .replace(/^@+/, '')
    .split('/')
    .map(foldText)
    .map((part, index) => (index === 0 ? stripSourcePrefix(part) : part))
    .filter(Boolean)
  return parts.length ? parts.join('/') : ''
}

/**
 * The identity of the skill this row was mirrored from, as "owner/slug".
 * Only SkillHub currently publishes this (`upstream_url`), and only for the
 * entries it imports from ClawHub. Returning '' means "this row is original
 * as far as we know" — which is not the same as "its identity is unknown".
 */
function upstreamIdentity(item) {
  if (!item.upstreamUrl) return ''
  const match = String(item.upstreamUrl).match(/clawhub\.ai\/([^/]+)\/([^/?#]+)/i)
  if (!match) return ''
  const owner = foldText(match[1])
  const slug = foldText(match[2])
  return owner && slug ? owner + '/' + slug : ''
}

/**
 * Fallback identity for a re-published skill: the same slug *and* the same
 * display name. Requiring both keeps two unrelated skills that merely share a
 * generic name apart, since their slugs almost always differ.
 */
function fuzzyIdentity(item) {
  const slug = foldText(item.slug)
  const name = foldText(item.name)
  if (!slug || !name) return ''
  // A one-word name like "github" is too common to merge on.
  if (name.length < 4) return ''
  return slug + '|' + name
}

// ── SkillHub mirror rotation ────────────────────────────────────────────────

/** Index of the mirror that answered last, so it is tried first next time. */
let mirrorCursor = 0

/**
 * Run `attempt` against the mirrors in turn until one answers.
 *
 * Not every failure means the same thing:
 *  - the caller cancelled (`AbortError`) — stop, the request is over;
 *  - the host timed out, refused the connection or failed TLS — try the next;
 *  - the host answered with a 5xx — try the next;
 *  - the host answered with a 4xx — it is alive and its answer is authoritative,
 *    so do not ask the others (a missing skill is missing on every mirror).
 *
 * The mirror that answered is remembered, so a working host is not re-probed on
 * every single request.
 */
async function withSkillHubMirror(config, attempt) {
  const mirrors = Array.isArray(config.skillhubMirrors) && config.skillhubMirrors.length
    ? config.skillhubMirrors
    : DEFAULT_SKILLHUB_MIRRORS

  if (mirrors.length === 1) return attempt(mirrors[0])

  const start = mirrorCursor % mirrors.length
  let lastError
  for (let offset = 0; offset < mirrors.length; offset += 1) {
    const index = (start + offset) % mirrors.length
    try {
      const value = await attempt(mirrors[index])
      mirrorCursor = index
      return value
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      const status = /^HTTP (\d{3})\b/.exec(String((error && error.message) || ''))
      if (status && Number(status[1]) >= 400 && Number(status[1]) < 500) throw error
      lastError = error
    }
  }
  throw lastError
}

/**
 * Route every SkillHub call through the rotation. The adapter is written against
 * a single base URL, so the retry loop is applied once here instead of being
 * repeated inside all four methods.
 */
for (const method of ['search', 'detail', 'readme', 'install']) {
  const original = skillhub[method]
  if (typeof original !== 'function') continue
  skillhub[method] = function onMirror(config, ...rest) {
    return withSkillHubMirror(config, (base) =>
      original.call(skillhub, { ...config, skillhubApiBase: base }, ...rest)
    )
  }
}

function resolveSourceList(config) {
  const list = []
  if (config.enableSkillHub) list.push('skillhub')
  if (config.enableClawHub) list.push('clawhub')
  return list
}

/**
 * Ask every enabled source at once. A slow or broken registry contributes an
 * entry to `errors` and nothing else — it never holds the others back.
 */
async function searchAcross(config, args, signal) {
  const requested = args.source && SOURCES[args.source] ? [args.source] : resolveSourceList(config)
  const page = toPositiveInt(args.page, 1, 200)
  const pageSize = toPositiveInt(args.pageSize, 30, 60)

  const outcomes = await Promise.all(
    requested.map(async (sourceId) => {
      const adapter = SOURCES[sourceId]
      // ClawHub exposes no offset, so it only participates in the first page.
      if (sourceId === 'clawhub' && page > 1) {
        return { sourceId, items: [], skipped: 'no-pagination' }
      }
      // A category is a SkillHub concept; other sources cannot honour it.
      if (args.category && !adapter.supportsCategory) {
        return { sourceId, items: [], skipped: 'no-category' }
      }
      try {
        const result = await adapter.search(config, { ...args, page, pageSize }, signal)
        return { sourceId, items: result.items || [], total: result.total, hasMore: result.hasMore }
      } catch (error) {
        if (isAbort(error) && signal && signal.aborted) throw error
        return {
          sourceId,
          items: [],
          error: isAbort(error) ? 'timed out' : clampText(error && error.message, 200)
        }
      }
    })
  )

  const errors = []
  for (const outcome of outcomes) {
    if (outcome.error) errors.push({ source: outcome.sourceId, error: outcome.error })
  }

  // De-duplicate. The catalogues overlap heavily — the same skill is routinely
  // republished across SkillHub, ClawHub and GitHub — so this list is one index
  // of unique skills, not a concatenation of mirrors.
  //
  // Tiers run from certain to heuristic. A heuristic tier never displaces a
  // confirmed identity. A bare slug is never a key on its own: "agent-browser"
  // is published by 30 unrelated people and "libai" names three different
  // skills, so the fallback tier requires the slug *and* the display name to
  // agree before two rows are called the same thing.
  const ranked = [...outcomes].sort(
    (a, b) => (SOURCE_RANK[a.sourceId] ?? 9) - (SOURCE_RANK[b.sourceId] ?? 9)
  )

  const merged = []
  const claimedIdentity = new Set() // an identity (own or mirrored) already in the index
  const claimedWithinSource = new Set() // "source|identity" to collapse a page's own repeats
  const claimedFuzzy = new Set() // "slug|name" already kept

  for (const outcome of ranked) {
    for (const item of outcome.items) {
      // Must fold segment-by-segment: this string is compared against
      // `upstream`, which also keeps its "/" separator.
      const namespace = normalizeIdentity(item.namespaceKey)
      // Only set when this row mirrors another registry (see upstreamIdentity).
      const upstream = upstreamIdentity(item)
      const fuzzy = fuzzyIdentity(item)

      // Everything this row could be: the skill it is, and the skill it copies.
      // Both are checked and both are recorded, because a mirror and its
      // original must collapse in either arrival order.
      const identities = [upstream, namespace].filter(Boolean)
      const withinKey = namespace ? outcome.sourceId + '|' + namespace : ''

      // The same page can repeat an entry; its own canonical name catches that.
      if (withinKey && claimedWithinSource.has(withinKey)) continue
      // An identity already present means an earlier, higher-ranked row is this
      // same skill. Ranking puts SkillHub first because it carries the Chinese
      // metadata, so the row kept here is the better-described one.
      if (identities.some((identity) => claimedIdentity.has(identity))) continue
      // Same slug *and* same display name: one skill republished by someone
      // else. Both signals must agree before a row is treated as a duplicate.
      if (fuzzy && claimedFuzzy.has(fuzzy)) continue

      if (withinKey) claimedWithinSource.add(withinKey)
      for (const identity of identities) claimedIdentity.add(identity)
      if (fuzzy) claimedFuzzy.add(fuzzy)
      merged.push(item)
    }
  }
  merged.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1
    const delta = (b.downloads || 0) - (a.downloads || 0)
    if (delta) return delta
    return String(a.name || '').localeCompare(String(b.name || ''))
  })

  // One row per visible name. SkillHub really does carry the same title under
  // several publishers, and some rows keep a trailing ".Skill" in the name, so
  // the grid showed what looked like the same card four times. The list is
  // ordered by downloads above, so the first row for a name is the most
  // popular one and the rest are the same skill republished.
  const seenNames = new Set()
  const unique = []
  for (const item of merged) {
    const key = foldText(item.name) || foldText(item.slug)
    if (key && seenNames.has(key)) continue
    if (key) seenNames.add(key)
    unique.push(item)
  }

  const totalKnown = outcomes.reduce((sum, outcome) => sum + (outcome.total || 0), 0)
  const hasMore = outcomes.some((outcome) => outcome.hasMore)

  // Per-source outcome, so an empty grid can say *why* it is empty. Without it
  // "all sources failed" and "nothing matched" render the same, and the panel
  // looks broken with no way to tell what happened.
  const diagnostics = outcomes.map((outcome) => ({
    source: outcome.sourceId,
    count: outcome.items.length,
    skipped: outcome.skipped || '',
    error: outcome.error || ''
  }))

  return {
    items: unique.slice(0, pageSize),
    total: totalKnown || merged.length,
    page,
    pageSize,
    hasMore: !!hasMore,
    sources: requested,
    errors,
    diagnostics
  }
}

async function resolveDetail(config, ref, signal) {
  const sourceId = ref && ref.source
  const adapter = SOURCES[sourceId]
  if (!adapter) throw new Error(`Unknown source "${sourceId}"`)

  let detail
  let sourceError = ''
  try {
    detail = await adapter.detail(config, ref, signal)
  } catch (error) {
    if (isAbort(error) && signal && signal.aborted) throw error
    sourceError = isAbort(error) ? 'timed out' : clampText(error && error.message, 200)
    detail = {
      id: sourceId + ':' + (ref.slug || ref.repoPath || ''),
      source: sourceId,
      sourceLabel: adapter.label,
      slug: ref.slug || '',
      owner: ref.owner || '',
      name: ref.slug || ref.repoPath || '',
      summary: '',
      summaryZh: '',
      tags: [],
      security: []
    }
  }

  const skillsDir = resolveSkillsDir(config)
  const localName = detail.slug || safeSkillDirName(ref.slug)
  const local = localName ? readSkillManifest(skillsDir, localName, 'SKILL.md') : null

  if (local) {
    detail.installed = true
    detail.localDir = local.dir
    if (!detail.readme && local.fileName === 'SKILL.md') detail.readme = local.content
    if (!detail.name) detail.name = localName
    if (!detail.summary) {
      const meta = parseFrontmatter(local.content)
      detail.summary = meta.description || ''
    }
  } else {
    detail.installed = false
  }

  if (!detail.readme && !local) {
    try {
      const readme = await adapter.readme(config, ref, signal)
      detail.readme = readme.content
      detail.readmeFile = readme.fileName
    } catch (error) {
      if (isAbort(error) && signal && signal.aborted) throw error
      detail.readmeError = isAbort(error) ? 'timed out' : clampText(error && error.message, 200)
    }
  }

  if (sourceError) detail.sourceError = sourceError
  return detail
}

async function installSkill(config, ref, signal) {
  const sourceId = ref && ref.source
  const adapter = SOURCES[sourceId]
  if (!adapter) return fail('bad-request', `Unknown source "${sourceId}"`)

  const slug = safeSkillDirName(ref.slug)
  if (!slug) {
    return fail('bad-request', `Invalid skill slug: ${clampText(ref.slug, 80)}`)
  }

  const skillsDir = resolveSkillsDir(config)
  const targetDir = join(skillsDir, slug)

  // A skill's directory name is its slug, and the catalogues share that
  // namespace: SkillHub alone lists four different "agent-browser" skills by
  // four different owners. Installing one used to rmSync whatever was already
  // there, so a second install silently deleted the first. Updating an existing
  // skill is still possible, but it has to be asked for.
  const allowOverwrite = ref.overwrite === true
  if (existsSync(targetDir) && !allowOverwrite) {
    return fail(
      'bad-request',
      `「${slug}」这个目录已被占用：不同作者的技能可能同名，只能装进同一个目录。请先到「已安装」里卸载已有的「${slug}」，再安装这一个。`
    )
  }

  let payload
  try {
    payload = await adapter.install(config, ref, signal)
  } catch (error) {
    if (isAbort(error) && signal && signal.aborted) return fail('cancelled', 'Install was cancelled')
    return fail('bad-request', `Failed to download "${slug}": ${clampText(error && error.message, 200)}`)
  }

  // Per-file failures an adapter chose to tolerate (a stale catalogue entry).
  let skippedFiles = []

  try {
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(targetDir, { recursive: true })

    if (Buffer.isBuffer(payload)) {
      extractZip(payload, targetDir)
    } else if (Array.isArray(payload)) {
      writeEntries(payload, targetDir)
    } else if (payload && Array.isArray(payload.entries)) {
      writeEntries(payload.entries, targetDir)
      if (Array.isArray(payload.skipped)) skippedFiles = payload.skipped
    } else {
      throw new Error('adapter returned no installable payload')
    }
  } catch (error) {
    try {
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    return fail('internal', `Failed to unpack "${slug}": ${clampText(error && error.message, 200)}`)
  }

  // Some archives wrap everything in one top-level directory; lift it up.
  if (!existsSync(join(targetDir, 'SKILL.md'))) {
    const children = readdirSync(targetDir).filter((entry) => {
      try {
        return statSync(join(targetDir, entry)).isDirectory()
      } catch {
        return false
      }
    })
    for (const child of children) {
      const childDir = join(targetDir, child)
      if (!existsSync(join(childDir, 'SKILL.md'))) continue
      for (const file of readdirSync(childDir)) {
        const from = join(childDir, file)
        const to = join(targetDir, file)
        try {
          if (existsSync(to)) rmSync(to, { recursive: true, force: true })
          renameSync(from, to)
        } catch {
          /* leave it in place rather than lose the file */
        }
      }
      try {
        rmSync(childDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      break
    }
  }

  if (!existsSync(join(targetDir, 'SKILL.md'))) {
    let leftovers = []
    try {
      leftovers = readdirSync(targetDir)
    } catch {
      leftovers = []
    }
    return fail(
      'bad-request',
      `"${slug}" does not contain a SKILL.md and cannot be loaded. Files: ${leftovers.join(', ') || '(none)'}`
    )
  }

  let meta = {}
  try {
    meta = parseFrontmatter(readFileSync(join(targetDir, 'SKILL.md'), 'utf8'))
  } catch {
    meta = {}
  }

  return ok({
    slug,
    name: meta.name || slug,
    description: meta.description || '',
    installed: true,
    dir: targetDir,
    source: sourceId,
    skippedFiles,
    message: skippedFiles.length
      ? `已安装「${meta.name || slug}」（${skippedFiles.length} 个文件在该源已不存在，已跳过）`
      : `已安装「${meta.name || slug}」`
  })
}

function uninstallSkill(config, ref) {
  const slug = safeSkillDirName(ref && ref.slug)
  if (!slug) return fail('bad-request', `Invalid skill slug: ${clampText(ref && ref.slug, 80)}`)

  const skillsDir = resolveSkillsDir(config)
  if (!existsSync(skillsDir)) return fail('bad-request', `技能目录不存在：${skillsDir}`)

  let targetDir = join(skillsDir, slug)
  if (!existsSync(targetDir)) {
    const lower = slug.toLowerCase()
    const match = readdirSync(skillsDir).find((entry) => entry.toLowerCase() === lower)
    if (!match) return fail('bad-request', `「${slug}」尚未安装`)
    targetDir = join(skillsDir, match)
  }

  try {
    rmSync(targetDir, { recursive: true, force: true })
  } catch (error) {
    return fail('internal', `删除失败：${clampText(error && error.message, 200)}`)
  }

  return ok({ slug, uninstalled: true, message: `已卸载「${slug}」` })
}

/**
 * Installed list = registry entries (when the skills service is present) merged
 * with a filesystem scan, so skills dropped in by hand also show up.
 */
async function listInstalled(config, signal, ctx) {
  const skillsDir = resolveSkillsDir(config)
  const local = listLocalSkills(skillsDir)
  const localBySlug = new Map(local.map((entry) => [entry.slug.toLowerCase(), entry]))

  let registry = []
  try {
    if (ctx && typeof ctx.skills === 'object' && ctx.skills && typeof ctx.skills.list === 'function') {
      const listed = await ctx.skills.list({ signal })
      registry = Array.isArray(listed) ? listed : []
    }
  } catch {
    registry = []
  }

  const seen = new Set()
  const merged = []

  for (const entry of registry) {
    const slug = entry.name || entry.slug
    if (!slug) continue
    const key = String(slug).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const localEntry = localBySlug.get(key)
    const invocation = entry.invocation || {}
    merged.push({
      slug,
      name: slug,
      summary: entry.description || '',
      summaryZh: '',
      version: (localEntry && localEntry.version) || '',
      author: entry.provider || (localEntry && localEntry.author) || '',
      installed: true,
      source: 'local',
      sourceLabel: '本地安装',
      dir: (entry.resourceBase && entry.resourceBase.path) || (localEntry && localEntry.dir) || '',
      fromRegistry: true,
      modelInvocable: !!invocation.modelInvocable,
      userInvocable: !!invocation.userInvocable
    })
  }

  for (const entry of local) {
    const key = entry.slug.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      ...entry,
      sourceLabel: '本地安装',
      fromRegistry: false,
      modelInvocable: true,
      userInvocable: true
    })
  }

  merged.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return { skills: merged, dir: skillsDir }
}

// ── config ──────────────────────────────────────────────────────────────────

function resolveConfig(config = {}) {
  return {
    skillhubApiBase: trimSlash(config.skillhubApiBase || DEFAULT_SKILLHUB_API),
    clawhubApiBase: trimSlash(config.clawhubApiBase || DEFAULT_CLAWHUB_API),
    jsdelivrDataApi: trimSlash(config.jsdelivrDataApi || DEFAULT_JSDELIVR_DATA),
    jsdelivrCdn: trimSlash(config.jsdelivrCdn || DEFAULT_JSDELIVR_CDN),
    githubApiBase: trimSlash(config.githubApiBase || DEFAULT_GITHUB_API),
    githubRawBase: trimSlash(config.githubRawBase || DEFAULT_GITHUB_RAW),
    githubToken: typeof config.githubToken === 'string' ? config.githubToken : '',
    localSkillsDir: config.localSkillsDir || '',
    enableSkillHub: config.enableSkillHub !== false,
    // Two channels, matching the catalogue they mirror: SkillHub (Chinese
    // metadata, and it already mirrors most of ClawHub) plus ClawHub itself.
    // The GitHub source was retired: its rows are English-only, duplicated what
    // the other two carry, and read as noise in the grid.
    enableClawHub: config.enableClawHub !== false,
    skillhubMirrors: parseMirrorList(config.skillhubMirrors, config.skillhubApiBase),
    githubRepos: parseRepoList(config.githubRepos || DEFAULT_GITHUB_REPOS),
    expertsRepo:
      typeof config.expertsRepo === 'string' && config.expertsRepo.trim()
        ? config.expertsRepo.trim()
        : DEFAULT_EXPERTS_REPO,
    enableExperts: config.enableExperts !== false,
    sourceTimeoutMs: toPositiveInt(config.sourceTimeoutMs, 8000, 60000),
    downloadTimeoutMs: toPositiveInt(config.downloadTimeoutMs, 60000, 300000),
    cacheTtlMs: toPositiveInt(config.cacheTtlMs, 600000, 86400000)
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

async function dispatch(endpoint, payload, signal, config, ctx) {
  const args = payload && payload.args ? payload.args : payload || {}
  const resolved = config

  switch (endpoint) {
    case 'sources': {
      const list = resolveSourceList(resolved).map((id) => ({
        id,
        label: SOURCES[id].label,
        supportsCategory: SOURCES[id].supportsCategory
      }))
      return ok({ sources: list })
    }

    case 'categories': {
      const list = await loadCategories(resolved, signal)
      return ok({ categories: [{ key: '', name: '全部', nameEn: 'All', sortOrder: -1 }, ...list] })
    }

    case 'experts': {
      if (!resolved.enableExperts) return ok({ repo: '', ref: '', departments: [], experts: [], total: 0 })
      const catalog = await loadExpertCatalog(resolved, signal)
      const installed = new Set(
        listLocalSkills(resolveSkillsDir(resolved)).map((item) => item.slug.toLowerCase())
      )
      return ok({
        ...catalog,
        experts: catalog.experts.map((expert) => ({
          ...expert,
          installed: installed.has(expert.stem.toLowerCase())
        }))
      })
    }

    case 'search': {
      const result = await searchAcross(resolved, args, signal)
      return ok(result)
    }

    case 'detail': {
      const ref = {
        source: args.source,
        slug: args.slug,
        owner: args.owner,
        repoRef: args.repoRef,
        repoPath: args.repoPath
      }
      if (!ref.source) return fail('bad-request', 'detail requires a source')
      const detail = await resolveDetail(resolved, ref, signal)
      return ok(detail)
    }

    case 'installed': {
      const listed = await listInstalled(resolved, signal, ctx)
      return ok(listed)
    }

    case 'install': {
      const ref = {
        source: args.source,
        slug: args.slug,
        owner: args.owner,
        repoRef: args.repoRef,
        repoPath: args.repoPath,
        // Replacing an existing install is opt-in: see installSkill.
        overwrite: args.overwrite === true
      }
      if (!ref.source) return fail('bad-request', 'install requires a source')
      return await installSkill(resolved, ref, signal)
    }

    case 'uninstall': {
      return uninstallSkill(resolved, args)
    }

    default:
      return fail('bad-request', `Unknown endpoint: ${endpoint}`)
  }
}

// ── plugin entry ────────────────────────────────────────────────────────────

const ENDPOINTS = ['sources', 'categories', 'experts', 'search', 'detail', 'installed', 'install', 'uninstall']

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)

  for (const endpoint of ENDPOINTS) {
    ctx.connection.fetch.register({
      path: `/api/skill-hub/${endpoint}`,
      methods: ['POST'],
      fetch: async (request) => {
        if (request.method !== 'POST') return new Response('not found', { status: 404 })

        let body
        try {
          body = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }

        const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
        try {
          const result = await dispatch(endpoint, body?.payload ?? {}, request.signal, resolved, ctx)
          return Response.json({ type: 'server-response', rpcId, result })
        } catch (error) {
          if (isAbort(error)) {
            return Response.json({
              type: 'server-response',
              rpcId,
              result: fail('cancelled', 'request was cancelled')
            })
          }
          return Response.json({
            type: 'server-response',
            rpcId,
            result: fail('internal', (error && error.message) || String(error))
          })
        }
      }
    })
  }
}
