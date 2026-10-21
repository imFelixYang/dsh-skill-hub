# dsh-skill-hub

A skill hub for **DeepSeek Harness**: search two public skill registries in one
place, read a skill's README before installing it, and install / uninstall it
into `$DSH_HOME/skills`.

It ships as a first-class DSH panel — the sidebar row, the centre-column page and
the composer picker are all contributed through the shell's own slot contracts,
so geometry, indent, label colour, hover state and the collapsed rail are owned
by DSH and follow whichever theme is active.

## What it does

- **One search box, two registries** — SkillHub (`api.skillhub.tencent.com`,
  fast in mainland China) and ClawHub (`clawhub.ai`). Results are merged and
  de-duplicated by slug, with installed skills pinned first.
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
| `clawhubApiBase` | `https://clawhub.ai` | ClawHub endpoint (`clawhub.com` just 307s here) |
| `localSkillsDir` | `''` | Where to install; empty means `$DSH_HOME/skills` |
| `preferSkillHub` | `true` | Which registry is queried first when both are enabled |

## RPC surface

The host half registers exact `POST /api/skill-hub/*` fetch routes (not a
blanket `/api` interceptor, so the official API gateway keeps working):

| Endpoint | Purpose |
| --- | --- |
| `skill-hub/search` | merged search across both registries |
| `skill-hub/detail` | skill detail + README |
| `skill-hub/installed` | installed skills (registry ∪ filesystem) |
| `skill-hub/install` | download + unpack into the skills directory |
| `skill-hub/uninstall` | remove an installed skill |
| `skill-hub/readme` | read a local `README.md` / `SKILL.md` |
| `skill-hub/categories` | SkillHub category list |

## Layout

```
dsh-skill-hub/
├── package.json          # dsh.bundle.patch + dsh.client declaration
├── cordis.patch.yml      # registers the plugin and its config defaults
├── src/
│   ├── index.js          # host half: RPC routes, HTTP clients, ZIP reader
│   └── client.js         # browser half: sidebar row, panel page, picker
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
