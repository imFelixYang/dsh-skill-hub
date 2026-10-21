/**
 * dsh-skill-hub — Host half
 *
 * Intercepts /api skill-hub/* RPC endpoints for the browser half.
 * All RPC endpoints use the Connection RPC intercept mechanism (POST /api/<endpoint>).
 *
 * Endpoints:
 *   skill-hub/search       — search skills across SkillHub + ClawHub
 *   skill-hub/detail       — get skill detail (README, versions, stats)
 *   skill-hub/installed    — list locally installed skills
 *   skill-hub/install      — download + install a skill to $DSH_HOME/skills/
 *   skill-hub/uninstall    — remove a locally installed skill
 *   skill-hub/readme       — read README.md / SKILL.md of an installed skill
 *   skill-hub/categories   — list skill categories from SkillHub
 *
 * Data sources:
 *   Primary: SkillHub (api.skillhub.tencent.com) — Tencent CN mirror, fast
 *   Fallback: ClawHub (clawhub.com) — official source
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

// ── Config ──────────────────────────────────────────────────────────────

const DEFAULT_SKILLHUB_API = 'https://api.skillhub.tencent.com'
// clawhub.com 已 307 跳转到 clawhub.ai，直接用新域名少一跳
const DEFAULT_CLAWHUB_API = 'https://clawhub.ai'

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the local skills directory.
 * Priority: config.localSkillsDir > $DSH_HOME/skills > ~/.dsh/skills
 */
function resolveSkillsDir(config) {
  if (config.localSkillsDir) return resolve(config.localSkillsDir)
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'skills')
}

/**
 * HTTP GET with JSON parse, timeout, and error containment.
 */
async function httpGetJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', ...headers },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * HTTP GET binary (for ZIP download).
 */
async function httpGetBuffer(url, { timeoutMs = 60000, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/zip,*/*', ...headers },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/**
 * RPC result helpers.
 */
function ok(value) {
  return { ok: true, value }
}
/**
 * RPC error helper.
 * NOTE: The 'code' must be one of the values in the dsh RPC Zod schema enum:
 * 'bad-request' | 'cancelled' | 'internal' | 'command-error' | 'unknown-command' | etc.
 * We only use 'bad-request' (user error) and 'internal' (server error) for skill-hub.
 */
function err(code, message, details = {}) {
  // Map unknown codes to allowed ones
  const allowedCodes = new Set([
    'bad-request', 'cancelled', 'internal', 'command-error', 'unknown-command',
    'settings-rejected', 'credential-rejected',
  ])
  const finalCode = allowedCodes.has(code) ? code : 'internal'
  return { ok: false, error: { code: finalCode, message, details } }
}

// ── SkillHub API ────────────────────────────────────────────────────────

/**
 * Search SkillHub (api.skillhub.tencent.com).
 * GET /api/skills?page=1&pageSize=20&keyword=xxx&sortBy=downloads&order=desc
 */
async function searchSkillHub(apiBase, keyword, page = 1, pageSize = 20, category = '') {
  const params = new URLSearchParams()
  if (keyword) params.set('keyword', keyword)
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  params.set('sortBy', 'downloads')
  params.set('order', 'desc')
  if (category) params.set('category', category)
  const url = `${apiBase}/api/skills?${params.toString()}`
  const data = await httpGetJson(url)
  // SkillHub returns { code: 0, data: { skills: [...], total: N } }
  const skills = data?.data?.skills ?? []
  const total = data?.data?.total ?? skills.length
  return {
    source: 'skillhub',
    items: skills.map(s => ({
      slug: s.slug ?? s.name ?? '',
      name: s.name ?? s.slug ?? '',
      displayName: s.displayName ?? s.name ?? '',
      summary: s.summary ?? s.description ?? '',
      summaryZh: s.summary_zh ?? s.description_zh ?? s.summaryZh ?? '',
      author: s.ownerName ?? s.author ?? s.namespace?.displayName ?? '',
      downloads: s.downloads ?? s.stats?.downloads ?? 0,
      installs: s.installs ?? s.stats?.installs ?? 0,
      stars: s.stars ?? s.stats?.stars ?? 0,
      iconUrl: s.iconUrl ?? '',
      verified: !!(s.verified ?? s.isAuthorVerified),
      homepage: s.homepage ?? s.upstream_url ?? '',
      version: s.version ?? '',
      tags: s.tags ?? s.subCategories ?? [],
      category: s.category ?? '',
      source: 'skillhub',
      installRef: s.slug ?? s.name ?? '',
    })),
    total,
    page,
    pageSize,
  }
}

/**
 * Get SkillHub skill detail (batch endpoint, no auth needed).
 * POST /api/v1/skills/batch with { slugs: [slug] }
 */
async function detailSkillHub(apiBase, slug) {
  // Try batch endpoint first (no auth needed)
  const url = `${apiBase}/api/v1/skills/batch`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ slugs: [slug] }),
    })
    clearTimeout(timer)
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const data = await res.json()
    // Batch API returns {count, items: [{skill: {...}, owner: {...}, latestVersion: {...}, securityReports: {...}}]}
    const items = data?.items ?? data?.data?.skills ?? data?.data ?? []
    const item = Array.isArray(items) ? items[0] : items?.[slug]
    if (!item) return null
    // The actual skill data may be nested under item.skill or directly on item
    const skill = item.skill ?? item
    const owner = item.owner ?? {}
    const latestVersion = item.latestVersion ?? {}
    return {
      slug: skill.slug ?? slug,
      name: skill.name ?? skill.slug ?? slug,
      displayName: skill.displayName ?? skill.name ?? slug,
      summary: skill.summary ?? skill.description ?? '',
      summaryZh: skill.summary_zh ?? '',
      author: owner.handle ?? owner.displayName ?? skill.author ?? '',
      downloads: skill.downloads ?? skill.stats?.downloads ?? 0,
      installs: skill.installs ?? skill.stats?.installs ?? 0,
      // 详情接口的统计值嵌在 skill.stats 里（搜索接口是平铺字段）
      stars: skill.stars ?? skill.stats?.stars ?? 0,
      iconUrl: skill.iconUrl ?? '',
      verified: !!(skill.verified ?? skill.isAuthorVerified),
      version: latestVersion.version ?? skill.version ?? '',
      tags: skill.tags ?? skill.subCategories ?? [],
      category: skill.category ?? '',
      readme: skill.readme ?? '',
      securityReports: item.securityReports ?? skill.securityReports ?? [],
      source: 'skillhub',
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

/**
 * Read a SkillHub skill file content.
 * GET /api/v1/skills/{slug}/file?path=SKILL.md
 */
async function readFileSkillHub(apiBase, slug, filePath) {
  const params = new URLSearchParams({ path: filePath })
  const url = `${apiBase}/api/v1/skills/${encodeURIComponent(slug)}/file?${params.toString()}`
  // File API returns binary (application/octet-stream), not JSON
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': '*/*' },
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download a SkillHub skill ZIP.
 * GET /api/v1/download?slug={slug}
 */
async function downloadSkillHub(apiBase, slug) {
  const url = `${apiBase}/api/v1/download?slug=${encodeURIComponent(slug)}`
  return httpGetBuffer(url)
}

// ── ClawHub API ──────────────────────────────────────────────────────────

/**
 * Search ClawHub (clawhub.com).
 * GET /api/v1/search?q={keyword}&limit={limit}
 */
async function searchClawHub(apiBase, keyword, limit = 20) {
  const params = new URLSearchParams({ q: keyword, limit: String(limit) })
  const url = `${apiBase}/api/v1/search?${params.toString()}`
  const data = await httpGetJson(url)
  const results = data?.results ?? []
  return {
    source: 'clawhub',
    items: results.map(r => {
      const ref = r.install?.reference ?? ''
      const [owner, slugPart] = ref.split('/')
      return {
        slug: r.slug ?? slugPart ?? r.name ?? '',
        name: r.name ?? r.slug ?? '',
        displayName: r.displayName ?? r.name ?? '',
        summary: r.summary ?? r.description ?? '',
        summaryZh: '',
        author: r.owner?.displayName ?? owner ?? r.author ?? '',
        downloads: r.downloads ?? 0,
        // ClawHub 没有 star，用收藏数（bookmarks）作为等价热度指标
        stars: r.metrics?.bookmarks ?? r.stars ?? 0,
        installs: r.metrics?.rolling60DayInstalls ?? r.installs ?? 0,
        iconUrl: r.icon ?? r.owner?.image ?? '',
        verified: !!(r.official ?? r.trust?.verified ?? r.publisher?.official),
        version: r.version ?? '',
        tags: r.tags ?? r.categories ?? [],
        category: r.category ?? '',
        source: 'clawhub',
        installRef: ref,
        ownerHandle: owner,
      }
    }),
    total: results.length,
    page: 1,
    pageSize: limit,
  }
}

/**
 * Get ClawHub skill detail.
 * GET /api/v1/skills/{slug}?ownerHandle={owner}
 */
async function detailClawHub(apiBase, slug, ownerHandle) {
  const params = new URLSearchParams()
  if (ownerHandle) params.set('ownerHandle', ownerHandle)
  const url = `${apiBase}/api/v1/skills/${encodeURIComponent(slug)}?${params.toString()}`
  const data = await httpGetJson(url)
  if (!data) return null
  return {
    slug: data.slug ?? slug,
    name: data.name ?? data.slug ?? slug,
    displayName: data.displayName ?? data.name ?? slug,
    summary: data.summary ?? data.description ?? '',
    summaryZh: '',
    author: data.owner?.displayName ?? data.author ?? ownerHandle ?? '',
    downloads: data.downloads ?? 0,
    stars: data.metrics?.bookmarks ?? data.stars ?? 0,
    installs: data.metrics?.rolling60DayInstalls ?? data.installs ?? 0,
    iconUrl: data.icon ?? data.owner?.image ?? '',
    verified: !!(data.official ?? data.verified),
    version: data.version ?? '',
    tags: data.tags ?? data.categories ?? [],
    category: data.category ?? '',
    readme: data.readme ?? '',
    securityReports: [],
    source: 'clawhub',
  }
}

/**
 * Download a ClawHub skill ZIP.
 * GET /api/v1/download?slug={slug}&ownerHandle={owner}
 */
async function downloadClawHub(apiBase, slug, ownerHandle) {
  const params = new URLSearchParams({ slug })
  if (ownerHandle) params.set('ownerHandle', ownerHandle)
  const url = `${apiBase}/api/v1/download?${params.toString()}`
  return httpGetBuffer(url)
}

// ── ZIP extraction (pure JS, no external process) ───────────────────────

/**
 * Reject archive entry names that could escape the target directory.
 * Returns a normalised relative path, or null when the entry must be skipped.
 */
function safeEntryPath(name) {
  // Normalise separators, drop a leading "./" and any drive/UNC prefix.
  let p = String(name).replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(p)) p = p.slice(2)
  p = p.replace(/^\/+/, '')
  const parts = []
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

/**
 * Parse a ZIP archive from memory and write its entries under `targetDir`.
 *
 * Reads the central directory rather than walking local headers: local headers
 * may defer sizes to a trailing data descriptor (general purpose bit 3), while
 * the central directory always carries the real sizes.
 *
 * Supports STORE (0) and DEFLATE (8), which is what skill publishers produce.
 * Nothing is executed and no temporary file is written, so this behaves the
 * same on every OS and needs no `tar`/PowerShell availability check.
 */
function extractZip(zipBuffer, targetDir) {
  mkdirSync(targetDir, { recursive: true })

  // Locate end-of-central-directory: signature PK\x05\x06, scanned from the end
  // because the trailing archive comment may be any length up to 65535 bytes.
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  const minEocd = Math.max(0, zipBuffer.length - 22 - 65535)
  for (let i = zipBuffer.length - 22; i >= minEocd; i--) {
    if (zipBuffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)')

  const entryCount = zipBuffer.readUInt16LE(eocd + 10)
  const centralOffset = zipBuffer.readUInt32LE(eocd + 16)

  let written = 0
  let skipped = 0
  let cursor = centralOffset
  for (let n = 0; n < entryCount; n++) {
    if (cursor + 46 > zipBuffer.length) break
    if (zipBuffer.readUInt32LE(cursor) !== 0x02014b50) break

    const method = zipBuffer.readUInt16LE(cursor + 10)
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24)
    const nameLen = zipBuffer.readUInt16LE(cursor + 28)
    const extraLen = zipBuffer.readUInt16LE(cursor + 30)
    const commentLen = zipBuffer.readUInt16LE(cursor + 32)
    const localOffset = zipBuffer.readUInt32LE(cursor + 42)
    const rawName = zipBuffer.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    cursor += 46 + nameLen + extraLen + commentLen

    if (rawName.endsWith('/')) continue // directory entry
    const relPath = safeEntryPath(rawName)
    if (!relPath) { skipped++; continue }

    // Local header repeats the name/extra lengths; data starts after them.
    if (localOffset + 30 > zipBuffer.length) { skipped++; continue }
    if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) { skipped++; continue }
    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26)
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const dataEnd = dataStart + compressedSize
    if (dataEnd > zipBuffer.length) { skipped++; continue }
    const raw = zipBuffer.slice(dataStart, dataEnd)

    let bytes
    if (method === 0) {
      bytes = raw
    } else if (method === 8) {
      bytes = inflateRawSync(raw)
    } else {
      skipped++ // unsupported compression, keep going
      continue
    }
    if (uncompressedSize >= 0 && bytes.length !== uncompressedSize) {
      // A size mismatch means the entry is damaged; refuse it rather than
      // writing a truncated SKILL.md.
      skipped++
      continue
    }

    const outPath = join(targetDir, relPath)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, bytes)
    written++
  }

  if (written === 0) {
    throw new Error(`archive contained no extractable files (skipped ${skipped})`)
  }
  return targetDir
}
// ── Local skill management ──────────────────────────────────────────────

/**
 * List locally installed skills by scanning the skills directory.
 * Each subdirectory with a SKILL.md is considered an installed skill.
 */
function listLocalSkills(skillsDir) {
  if (!existsSync(skillsDir)) return []
  const entries = readdirSync(skillsDir, { withFileTypes: true })
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsDir, entry.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    // Parse frontmatter from SKILL.md
    const content = readFileSync(skillMdPath, 'utf8')
    const meta = parseFrontmatter(content)
    skills.push({
      name: meta.name ?? entry.name,
      dirName: entry.name,
      description: meta.description ?? '',
      whenToUse: meta.whenToUse ?? '',
      version: meta.metadata?.version ?? '',
      author: meta.metadata?.author ?? '',
      installed: true,
      dir: skillDir,
    })
  }
  return skills
}

/**
 * Parse YAML frontmatter from a Markdown file.
 *
 * Deliberately small: SKILL.md frontmatter is a shallow mapping of scalars,
 * sometimes with one `metadata:` block. Block scalars (`>-`, `>`, `|`) are
 * folded, because publishers use them for multi-line descriptions — treating
 * `>-` as the value itself would surface a literal ">-" in the UI.
 */
function parseFrontmatter(text) {
  const result = {}
  if (!String(text).startsWith('---')) return result
  const end = text.indexOf('\n---', 3)
  if (end < 0) return result

  const lines = text.slice(3, end).split('\n')
  let target = result
  let targetIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = line.match(/^(\s*)/)[0].length
    const trimmed = line.trim()

    // Leaving a nested block: back to the root mapping.
    if (targetIndent >= 0 && indent <= targetIndent && !/^\s/.test(line)) {
      target = result
      targetIndent = -1
    }

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 0) continue
    const key = trimmed.slice(0, colonIdx).trim()
    if (!key) continue
    let value = trimmed.slice(colonIdx + 1).trim()

    // Block scalar: gather the following more-indented lines.
    if (value === '' || /^[>|][+-]?$/.test(value)) {
      const folded = /^[>|]/.test(value)
      const block = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const next = lines[j]
        if (!next.trim()) { block.push(''); continue }
        if (next.match(/^(\s*)/)[0].length <= indent) break
        block.push(next.trim())
      }
      i = j - 1
      if (folded) {
        const joined = block.join(' ').replace(/\s+/g, ' ').trim()
        if (joined) { target[key] = joined; continue }
      } else if (block.length) {
        target[key] = block.join('\n').trim()
        continue
      }
      if (key === 'metadata') {
        target.metadata = {}
        target = target.metadata
        targetIndent = indent
      }
      continue
    }

    // Scalar: strip matching quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    target[key] = value
  }

  return result
}

/**
 * Read a skill's README.md or SKILL.md content.
 */
function readSkillFile(skillsDir, skillName, fileName) {
  // Try exact directory name first, then case-insensitive
  let skillDir = join(skillsDir, skillName)
  if (!existsSync(skillDir)) {
    // Search for case-insensitive match
    if (existsSync(skillsDir)) {
      const entries = readdirSync(skillsDir, { withFileTypes: true })
      const match = entries.find(e => e.isDirectory() && e.name.toLowerCase() === skillName.toLowerCase())
      if (match) {
        skillDir = join(skillsDir, match.name)
      } else {
        return null
      }
    } else {
      return null
    }
  }

  // Try the requested file, then README.md, then SKILL.md
  const candidates = [fileName, 'README.md', 'SKILL.md'].filter(Boolean)
  for (const candidate of candidates) {
    const filePath = join(skillDir, candidate)
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf8')
      return { fileName: candidate, content, dir: skillDir }
    }
  }
  return null
}

// ── RPC handler ─────────────────────────────────────────────────────────

/**
 * Main RPC dispatch: routes skill-hub/* endpoints to handlers.
 */
async function dispatch(endpoint, payload, signal, config, ctx) {
  // dsh RPC framework wraps the caller's payload as { args: actualPayload }
  const args = (payload && payload.args) ? payload.args : (payload || {})
  const skillhubApi = config.skillhubApiBase || DEFAULT_SKILLHUB_API
  const clawhubApi = config.clawhubApiBase || DEFAULT_CLAWHUB_API
  const preferSkillHub = config.preferSkillHub !== false
  const skillsDir = resolveSkillsDir(config)

  switch (endpoint) {
    case 'skill-hub/search': {
      const { keyword = '', page = 1, pageSize = 60, source, category = '' } = args
      const sources = source ? [source] : (preferSkillHub ? ['skillhub', 'clawhub'] : ['clawhub', 'skillhub'])
      const results = []
      const errors = []

      for (const src of sources) {
        try {
          if (src === 'skillhub') {
            const r = await searchSkillHub(skillhubApi, keyword, page, pageSize, category)
            results.push(r)
          } else if (src === 'clawhub') {
            const limit = Math.min(pageSize, 30)
            const r = await searchClawHub(clawhubApi, keyword, limit)
            results.push(r)
          }
        } catch (e) {
          errors.push({ source: src, error: e.message })
        }
      }

      // Merge and deduplicate by slug (case-insensitive)
      const seen = new Set()
      const merged = []
      for (const r of results) {
        for (const item of r.items) {
          const key = (item.slug || item.name).toLowerCase()
          if (key && !seen.has(key)) {
            seen.add(key)
            merged.push(item)
          }
        }
      }

      // Sort: installed first, then by downloads
      const localSkills = listLocalSkills(skillsDir)
      const localNames = new Set(localSkills.map(s => s.name.toLowerCase()))
      merged.forEach(item => {
        item.installed = localNames.has((item.slug || item.name).toLowerCase())
      })
      merged.sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1
        return (b.downloads ?? 0) - (a.downloads ?? 0)
      })

      return ok({
        items: merged,
        total: merged.length,
        sources: results.map(r => r.source),
        errors,
      })
    }

    case 'skill-hub/detail': {
      const { slug, source, ownerHandle } = args
      if (!slug) return err('bad-request', 'slug is required')

      let detail = null
      const errors = []

      // Try the specified source first, then fallback
      const trySources = source
        ? [source, ...(source === 'skillhub' ? ['clawhub'] : ['skillhub'])]
        : (preferSkillHub ? ['skillhub', 'clawhub'] : ['clawhub', 'skillhub'])

      for (const src of trySources) {
        try {
          if (src === 'skillhub') {
            detail = await detailSkillHub(skillhubApi, slug)
          } else if (src === 'clawhub') {
            detail = await detailClawHub(clawhubApi, slug, ownerHandle)
          }
          if (detail) break
        } catch (e) {
          errors.push({ source: src, error: e.message })
        }
      }

      if (!detail) {
        // Last resort: try reading from local file system (installed skill)
        const fileData = readSkillFile(skillsDir, slug, 'SKILL.md')
        if (fileData) {
          detail = {
            slug,
            name: slug,
            displayName: slug,
            summary: '',
            readme: fileData.content,
            installed: true,
            source: 'local',
          }
        } else {
          return err('bad-request', `Skill "${slug}" not found`, { errors })
        }
      }

      // If no README from API, try reading from file system (installed skill)
      if (!detail.readme) {
        const localSkills = listLocalSkills(skillsDir)
        const local = localSkills.find(s => s.name.toLowerCase() === slug.toLowerCase())
        if (local) {
          const fileData = readSkillFile(skillsDir, slug, 'README.md')
          if (fileData) {
            detail.readme = fileData.content
            detail.installed = true
          } else {
            const skillMd = readSkillFile(skillsDir, slug, 'SKILL.md')
            if (skillMd) {
              detail.readme = skillMd.content
              detail.installed = true
            }
          }
        } else {
          // Try ctx.skills registry (for plugin-bundled skills)
          if (ctx && ctx.skills) {
            try {
              const regSkill = await ctx.skills.get(slug, { signal })
              if (regSkill && regSkill.content) {
                detail.readme = regSkill.content
                detail.installed = true
              }
            } catch (e) { /* Ignore */ }
          }
          // Try fetching SKILL.md from SkillHub file API
          if (!detail.readme && detail.source !== 'clawhub') {
            try {
              const fileContent = await readFileSkillHub(skillhubApi, slug, 'SKILL.md')
              if (fileContent) {
                detail.readme = fileContent
              }
            } catch (e) {
              // Ignore file fetch errors
            }
          }
        }
      }

      // Check if installed locally (don't override if already determined via ctx.skills)
      if (!detail.installed) {
        const localSkills = listLocalSkills(skillsDir)
        detail.installed = localSkills.some(s => s.name.toLowerCase() === slug.toLowerCase())
      }

      return ok(detail)
    }

    case 'skill-hub/installed': {
      const sourceLabels = {
        'user-dsh': '本地安装',
        'user-agents': '用户Agent',
        'project-dsh': '项目',
        'project-agents': '项目Agent',
        'bundled': '插件自带',
        'custom': '自定义',
        'runtime': '运行时',
      }
      // Try ctx.skills registry first (covers plugin-bundled + user-installed)
      let registrySkills = []
      if (ctx && ctx.skills) {
        try {
          const summaries = await ctx.skills.list({ signal })
          registrySkills = summaries.map(s => ({
            slug: s.name,
            name: s.name,
            displayName: s.name,
            summary: s.description || '',
            description: s.description || '',
            whenToUse: s.whenToUse || '',
            source: s.source || '',
            sourceLabel: sourceLabels[s.source] || s.source || '',
            provider: s.provider || '',
            author: s.provider || '',
            modelInvocable: s.invocation ? s.invocation.modelInvocable : false,
            userInvocable: s.invocation ? s.invocation.userInvocable : false,
            installed: true,
            dir: (s.resourceBase && s.resourceBase.path) || '',
            fromRegistry: true,
          }))
        } catch (e) {
          // Fall through to file scanning
        }
      }
      // Also scan local skills dir for metadata (version, author from frontmatter)
      const localSkills = listLocalSkills(skillsDir)
      if (registrySkills.length > 0) {
        const localMap = {}
        for (const ls of localSkills) {
          localMap[ls.name.toLowerCase()] = ls
        }
        // Merge: enrich registry skills with local metadata, AND add local-only
        // skills that the registry didn't return (e.g. user-installed skills
        // under ~/.dsh/skills/ that ctx.skills.list missed because no cwd was
        // passed to resolve project/user roots).
        const registryNames = new Set(registrySkills.map(rs => rs.name.toLowerCase()))
        // Build merged list: registry skills enriched with local metadata
        const merged = registrySkills.map(rs => {
          const local = localMap[rs.name.toLowerCase()]
          if (local) {
            return Object.assign({}, rs, {
              version: local.version || '',
              author: local.author || rs.author,
              dir: local.dir || rs.dir,
            })
          }
          return rs
        })
        // Append local-only skills not in registry
        for (const ls of localSkills) {
          if (!registryNames.has(ls.name.toLowerCase())) {
            merged.push(Object.assign({}, ls, {
              slug: ls.slug || ls.name,
              displayName: ls.displayName || ls.name,
              summary: ls.summary || ls.description || '',
              source: ls.source || 'user-dsh',
              sourceLabel: sourceLabels['user-dsh'] || '本地安装',
              provider: '',
              author: ls.author || '',
              modelInvocable: true,
              userInvocable: true,
              installed: true,
              dir: ls.dir || '',
              fromRegistry: false,
            }))
          }
        }
        return ok({ skills: merged, dir: skillsDir })
      }
      // Fallback: file scan only
      const localWithLabels = localSkills.map(s => Object.assign({}, s, {
        slug: s.slug || s.name,
        displayName: s.displayName || s.name,
        summary: s.summary || s.description || '',
        sourceLabel: '本地安装',
        installed: true,
      }))
      return ok({ skills: localWithLabels, dir: skillsDir })
    }

    case 'skill-hub/install': {
      const { slug, source, ownerHandle } = args
      if (!slug) return err('bad-request', 'slug is required')

      // Determine which source to use
      const src = source || (preferSkillHub ? 'skillhub' : 'clawhub')
      let zipBuffer

      try {
        if (src === 'skillhub') {
          zipBuffer = await downloadSkillHub(skillhubApi, slug)
        } else {
          zipBuffer = await downloadClawHub(clawhubApi, slug, ownerHandle)
        }
      } catch (e) {
        // Fallback to the other source
        const fallbackSrc = src === 'skillhub' ? 'clawhub' : 'skillhub'
        try {
          if (fallbackSrc === 'skillhub') {
            zipBuffer = await downloadSkillHub(skillhubApi, slug)
          } else {
            zipBuffer = await downloadClawHub(clawhubApi, slug, ownerHandle)
          }
        } catch (e2) {
          return err('bad-request', `Failed to download skill: ${e.message}; fallback also failed: ${e2.message}`)
        }
      }

      // Extract to skills directory
      const targetDir = join(skillsDir, slug)
      // Clean existing directory if any
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true })
      }
      mkdirSync(targetDir, { recursive: true })

      try {
        extractZip(zipBuffer, targetDir)
      } catch (e) {
        // Cleanup on failure
        try { rmSync(targetDir, { recursive: true, force: true }) } catch {}
        return err('internal', `Failed to extract skill: ${e.message}`)
      }

      // Verify SKILL.md exists
      const skillMdPath = join(targetDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) {
        // Check if files are in a subdirectory
        const subEntries = readdirSync(targetDir, { withFileTypes: true })
        const subDir = subEntries.find(e => e.isDirectory())
        if (subDir) {
          const subSkillMd = join(targetDir, subDir.name, 'SKILL.md')
          if (existsSync(subSkillMd)) {
            // Flatten one nesting level (publishers sometimes wrap the skill
            // in a folder). renameSync is a same-volume move on every platform.
            const subDirPath = join(targetDir, subDir.name)
            for (const f of readdirSync(subDirPath)) {
              const src = join(subDirPath, f)
              const dst = join(targetDir, f)
              try {
                if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
                renameSync(src, dst)
              } catch {
                // Leave the file where it is rather than losing it; the SKILL.md
                // check below still decides whether the install is usable.
              }
            }
            try { rmSync(subDirPath, { recursive: true, force: true }) } catch {}
          }
        }
      }

      // Final verification
      if (!existsSync(skillMdPath)) {
        return err('bad-request', `Downloaded skill does not contain SKILL.md. Files: ${readdirSync(targetDir).join(', ')}`)
      }

      // Parse the installed skill's metadata
      const content = readFileSync(skillMdPath, 'utf8')
      const meta = parseFrontmatter(content)

      return ok({
        slug,
        name: meta.name ?? slug,
        description: meta.description ?? '',
        installed: true,
        dir: targetDir,
        message: `Skill "${slug}" installed successfully`,
      })
    }

    case 'skill-hub/uninstall': {
      const { slug } = args
      if (!slug) return err('bad-request', 'slug is required')

      const targetDir = join(skillsDir, slug)
      if (!existsSync(targetDir)) {
        // Try case-insensitive search
        if (existsSync(skillsDir)) {
          const entries = readdirSync(skillsDir, { withFileTypes: true })
          const match = entries.find(e => e.isDirectory() && e.name.toLowerCase() === slug.toLowerCase())
          if (match) {
            rmSync(join(skillsDir, match.name), { recursive: true, force: true })
            return ok({ slug, uninstalled: true, message: `Skill "${match.name}" removed` })
          }
        }
        return err('bad-request', `Skill "${slug}" is not installed`)
      }

      rmSync(targetDir, { recursive: true, force: true })
      return ok({ slug, uninstalled: true, message: `Skill "${slug}" removed` })
    }

    case 'skill-hub/readme': {
      const { slug, fileName } = args
      if (!slug) return err('bad-request', 'slug is required')

      // Try local file system first
      const fileData = readSkillFile(skillsDir, slug, fileName)
      if (fileData) {
        const allFiles = existsSync(fileData.dir)
          ? readdirSync(fileData.dir).filter(f => !statSync(join(fileData.dir, f)).isDirectory())
          : []
        return ok({
          slug,
          fileName: fileData.fileName,
          content: fileData.content,
          files: allFiles,
          dir: fileData.dir,
        })
      }

      // Try ctx.skills registry (for plugin-bundled skills not in ~/.dsh/skills)
      if (ctx && ctx.skills) {
        try {
          const skill = await ctx.skills.get(slug, { signal })
          if (skill && skill.content) {
            return ok({
              slug,
              fileName: 'SKILL.md',
              content: skill.content,
              files: [],
              dir: skill.path || '',
            })
          }
        } catch (e) { /* Ignore */ }
      }

      return err('bad-request', `No README or SKILL.md found for "${slug}"`)
    }

    case 'skill-hub/categories': {
      try {
        const url = `${skillhubApi}/api/v1/categories`
        const data = await httpGetJson(url)
        const items = data?.items ?? data?.data ?? []
        return ok({ categories: items })
      } catch (e) {
        return err('internal', `Failed to fetch categories: ${e.message}`)
      }
    }

    default:
      return err('bad-request', `Unknown endpoint: ${endpoint}`)
  }
}

// ── Plugin entry ────────────────────────────────────────────────────────

export const name = 'dsh-skill-hub'
export const inject = ['connection', 'skills']

export function apply(ctx, config = {}) {
  // Merge config from cordis.patch.yml
  const mergedConfig = {
    skillhubApiBase: config.skillhubApiBase || DEFAULT_SKILLHUB_API,
    clawhubApiBase: config.clawhubApiBase || DEFAULT_CLAWHUB_API,
    preferSkillHub: config.preferSkillHub !== false,
    localSkillsDir: config.localSkillsDir || '',
  }

  // 2026-09-02 修复：dsh 0.1.2-alpha 起 /api 共享通道只允许一个 interceptor
  // （官方 dsh-api-gateway 独占），插件再 intercept 会把 gateway 挤掉，导致
  // workspace/session/directoryPicker 等所有官方 /api 端点 404。
  // 改用 exact fetch route（优先级高于 interceptor），与 gateway 共存。
  const ENDPOINTS = [
    'skill-hub/search',
    'skill-hub/detail',
    'skill-hub/installed',
    'skill-hub/install',
    'skill-hub/uninstall',
    'skill-hub/readme',
    'skill-hub/categories',
  ]

  for (const endpoint of ENDPOINTS) {
    ctx.connection.fetch.register({
      path: `/api/${endpoint}`,
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
          const result = await dispatch(endpoint, body?.payload ?? {}, request.signal, mergedConfig, ctx)
          return Response.json({ type: 'server-response', rpcId, result })
        } catch (error) {
          return Response.json({
            type: 'server-response',
            rpcId,
            result: err('internal', error?.message || String(error)),
          })
        }
      },
    })
  }
}
