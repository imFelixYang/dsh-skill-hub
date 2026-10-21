# SkillAgency

**技能 · 专家** — a skill *and* expert hub for **DeepSeek Harness**: search
several public skill registries in one place, read a skill's README before
installing it, and install / uninstall it into `$DSH_HOME/skills`. A second tab
adds an **expert roster** — 300+ role personas that install the same way and are
picked from the same panel.

It ships as a first-class DSH panel — the sidebar row, the centre-column page and
the composer picker are all contributed through the shell's own slot contracts,
so geometry, indent, label colour, hover state and the collapsed rail are owned
by DSH and follow whichever theme is active.

## What it does

- **One search box, two registries** — queried in parallel, merged, and
  de-duplicated, with installed skills pinned first:
  - **SkillHub** (`api.skillhub.tencent.com`) — fast in mainland China, ~21k
    skills, Chinese summaries and category filters. It also mirrors most of
    ClawHub, so the two lists overlap heavily and are folded together.
  - **ClawHub** (`clawhub.ai`) — the OpenClaw registry.
- **Chinese first** — SkillHub's `description_zh` and Chinese skill names are
  preferred when present, and the category list is shown in Chinese. The
  interface itself is Chinese, by product decision: the audience is Chinese and
  a half-translated panel read worse than a single language.
- **Fast by default** — sources are fetched concurrently rather than in
  sequence, a slow registry can no longer stall the whole search, and a short
  timeout plus a warm cache keep repeat searches instant.
- **Read before you install** — a skill's `SKILL.md` / `README.md` is rendered
  in place, so you can see what it actually does.
- **Install / uninstall** — downloads the skill archive and unpacks it into
  `$DSH_HOME/skills/<slug>/`. Unpacking is pure JavaScript (`node:zlib`), so it
  works the same on Windows, macOS and Linux with no `tar` or PowerShell
  dependency.
- **Installed list** — merges the DSH skill registry with a scan of the skills
  directory, so skills installed by other means still show up.
- **Composer picker** — a small button next to the chat input inserts
  `/skill-name` for any installed skill.
- **Expert roster** — a second tab lists 328 role personas grouped into 22
  departments, taken from [`jnMetaCode/agency-agents-zh`](https://github.com/jnMetaCode/agency-agents-zh)
  by default and configurable via `expertsRepo`. Each persona is a single
  Markdown file; installing one rewrites it into a valid `SKILL.md` (front
  matter with a lowercase-hyphen `name`, the Chinese role name folded into
  `description`) so DSH loads it like any other skill. The roster is browsed,
  not searched: it stays out of the keyword search and has its own filter.

## Design notes

A few properties this plugin holds itself to:

- **Only public contracts.** `ctx.slots.inject(...)` / `ctx.slots.register(...)`
  for UI seats, `ctx.connection.fetch.register(...)` for host routes,
  `ctx.connection.rpc.call('/api', ...)` on the client. No DOM surgery, no
  reaching into other plugins' styles, no patching the shell.
- **Theme tokens only.** Every colour is a `--dsw-alias-*` token, so built-in
  themes, the OpenCode palette and custom skins all work without special cases.
- **Degrade, don't break.** Every `slots.inject` is wrapped, so a shell that
  never declares a seat leaves the panel absent instead of failing boot.
- **Pure-JS archive handling.** The ZIP reader walks the central directory and
  inflates in memory; it never shells out and never writes a temp file.
- **Path-safe installs.** Archive entry names are normalised and rejected if
  they escape the target directory; slugs are validated before they reach the
  filesystem.
- **Routes are chosen by measurement.** The expert roster is read through the
  GitHub contents API first, then `raw.githubusercontent.com`, then jsDelivr.
  That order looks backwards, but on a mainland connection the two plain-text
  hosts answered in 17–20 seconds (or timed out) while the API answered in
  under a second. The roster is two small documents, so the quota cost is
  bounded and `githubToken` lifts it when needed.
- **Fewer sources, on purpose.** A third catalogue (arbitrary GitHub repos) was
  implemented and then removed: its rows carried no downloads, no Chinese
  summary, and mostly duplicated what SkillHub already mirrored, so it made the
  grid look busy without making it more useful. Two well-described catalogues
  beat three overlapping ones.

## Install

```bash
git clone https://github.com/imFelixYang/dsh-skill-hub.git
```

Then in DSH: **插件 → 安装 bundle**, and pick the cloned directory (the one
containing `package.json`). DSH restarts the plugin host; a **技能中心** row
appears in the sidebar, between the built-in entries.

To update later:

```bash
cd dsh-skill-hub && git pull
```

and re-install the bundle, or restart DSH.

## Configuration

All options live in the plugin's `cordis.patch.yml` and can be overridden from
the DSH plugin settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `skillhubApiBase` | `https://api.skillhub.tencent.com` | SkillHub endpoint |
| `skillhubMirrors` | `api.skillhub.tencent.com`, `api.skillhub.cn` | Tried in order; the first that answers wins, so a blocked or slow host degrades instead of failing |
| `clawhubApiBase` | `https://clawhub.ai` | ClawHub endpoint (`clawhub.com` just 307s here) |
| `githubApiBase` | `https://api.github.com` | Used to read the expert roster's Markdown files |
| `githubRawBase` | `https://raw.githubusercontent.com` | Fallback host for those same files |
| `githubToken` | `''` | Optional GitHub token; raises the 60-requests/hour anonymous limit |
| `jsdelivrCdn` | `https://cdn.jsdelivr.net` | Last-resort file host when both above fail |
| `localSkillsDir` | `''` | Where to install; empty means `$DSH_HOME/skills` |
| `enableSkillHub` | `true` | Turn the SkillHub source on or off |
| `enableClawHub` | `true` | Turn the ClawHub source on or off |
| `expertsRepo` | `jnMetaCode/agency-agents-zh@main` | Roster repo for the Experts tab (`owner/repo@ref`) |
| `enableExperts` | `true` | Turn the Experts tab on or off |
| `sourceTimeoutMs` | `8000` | Per-source budget before it is reported as slow and skipped |
| `downloadTimeoutMs` | `60000` | Budget for downloading a skill archive |
| `cacheTtlMs` | `600000` | How long tree listings and detail responses stay warm |

## RPC surface

The host half registers exact `POST /api/skill-hub/*` fetch routes (not a
blanket `/api` interceptor, so the official API gateway keeps working):

| Endpoint | Purpose |
| --- | --- |
| `skill-hub/sources` | which registries are enabled, with labels |
| `skill-hub/search` | merged, parallel search across every enabled source |
| `skill-hub/detail` | skill detail + README |
| `skill-hub/installed` | installed skills (registry ∪ filesystem) |
| `skill-hub/install` | download + unpack into the skills directory |
| `skill-hub/uninstall` | remove an installed skill |
| `skill-hub/readme` | read a local `README.md` / `SKILL.md` |
| `skill-hub/categories` | category list, in Chinese |
| `skill-hub/experts` | the expert roster, grouped by department |

## Layout

```
dsh-skill-hub/
├── package.json          # dsh.bundle.patch + dsh.client declaration
├── cordis.patch.yml      # registers the plugin and its config defaults
├── src/
│   ├── index.js          # host half: RPC routes, HTTP clients, ZIP reader
│   └── client.js         # browser half: sidebar row, panel page, picker
├── test/
│   ├── verify.mjs        # offline: routes, parsing, path safety, de-duplication
│   ├── render.mjs        # offline: renders the browser half against a React stub
│   └── live.mjs          # online: real search → detail → install → uninstall
└── LICENSE               # MIT
```

The browser half is plain ES5-flavoured JavaScript wrapped in
`window.__ModuleLoader__.load({ id, factory })` — no build step, no bundler, no
second copy of React. It is loaded by DSH exactly as written.

## Staying compatible with DSH

The plugin only uses documented public contracts:

- `ctx.slots.inject(name, () => ctx.slots.register(options, Component))`
- `ctx.connection.fetch.register({ path, methods, fetch })` on the host
- `ctx.connection.rpc.call('/api', endpoint, payload, signal)` on the client
- `--dsw-alias-*` theme tokens for every colour

DSH is pre-1.0, so seats and tokens can still change. When that happens the
plugin is meant to degrade rather than break.

## License

MIT — see [LICENSE](./LICENSE).
