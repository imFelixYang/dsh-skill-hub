// Offline verification for dsh-skill-hub.
//
//   node test/verify.mjs
//
// No network, no browser. It covers everything that is checkable in isolation:
//
//   1. both halves parse, and the client half loads through the same
//      `window.__ModuleLoader__` shim the DSH web shell uses;
//   2. the client claims exactly the three documented seats and never touches
//      the DOM outside its own components;
//   3. the sidebar glyph honours the `size` prop the shell passes;
//   4. the host registers exactly the seven documented RPC routes, POST only,
//      and answers GET → 404 / bad body → 400 before touching the network;
//   5. categories degrade to the built-in Chinese catalogue when the upstream
//      endpoint is unreachable;
//   6. a search asks every source concurrently, so one dead registry yields a
//      partial result plus an entry in `errors` instead of a failed request;
//   7. the markdown renderer escapes HTML, balances its tags and drops
//      executable URLs (a readme is remote content);
//   8. a traversing `slug` cannot escape the skills directory.
//
// Visual behaviour (alignment, theme colours) needs the bundle installed in DSH.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ── 1. Loader shim ───────────────────────────────────────────────────

const clientSource = read("../src/client.js");

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect() {},
  useRef(value) {
    return { current: value };
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  }
};

const loads = [];
globalThis.window = {
  __ModuleLoader__: { load: (mod) => loads.push(mod) },
  setTimeout: () => 0,
  clearTimeout: () => {}
};
globalThis.document = {
  documentElement: { lang: "zh-CN" },
  addEventListener: () => {},
  removeEventListener: () => {}
};

eval(clientSource);

check("client registers exactly one module", loads.length === 1, `got ${loads.length}`);
const mod = loads[0];
check("module id is dsh-skill-hub", mod.id === "dsh-skill-hub", mod.id);

const client = mod.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected require: ${name}`);
});

check("client exports apply", typeof client.apply === "function");
check("client exports inject", Array.isArray(client.inject));

// ── 2. Seats ─────────────────────────────────────────────────────────

const ALLOWED = new Set(["sidebar.panellist", "main", "conversation.input.left"]);
const registrations = [];
const effects = [];

const slots = {
  inject(ownerKey, factory) {
    if (!ALLOWED.has(ownerKey)) throw new Error(`unexpected slot: ${ownerKey}`);
    const dispose = factory();
    return typeof dispose === "function" ? dispose : () => {};
  },
  register(options, Component) {
    registrations.push({ options, Component });
    return () => {};
  }
};

const rpc = { call: async () => ({ ok: true, value: { items: [], skills: [], categories: [], sources: [] } }) };
const ctx = {
  slots,
  get(name) {
    if (name !== "connection") throw new Error(`unexpected service: ${name}`);
    return { rpc };
  },
  effect(fn, label) {
    effects.push(label);
    return fn();
  }
};

client.apply(ctx);

const seats = registrations.map((r) => r.options.name);
check(
  "claims exactly the three documented seats",
  JSON.stringify(seats) === JSON.stringify(["sidebar.panellist", "main", "conversation.input.left"]),
  JSON.stringify(seats)
);

const sidebarOptions = registrations.find((r) => r.options.name === "sidebar.panellist").options;
const mainOptions = registrations.find((r) => r.options.name === "main").options;
check("sidebar row carries an id", typeof sidebarOptions.id === "string" && sidebarOptions.id.length > 0);
check("sidebar row carries an order", typeof sidebarOptions.order === "number");
check("sidebar row label is a thunk", typeof sidebarOptions.label === "function");
check("main page key matches the sidebar id", mainOptions.key === sidebarOptions.id);

// The whole point of the rewrite: no DOM surgery outside our own tree.
for (const banned of [
  "document.body",
  "appendChild",
  "insertBefore",
  "querySelector",
  "MutationObserver",
  "favicon",
  "mountBrand"
]) {
  check(`client never uses ${banned}`, !clientSource.includes(banned));
}

// The host's connection RPC is a four-argument call: channel, endpoint, payload,
// signal. Passing three hands the payload in as the endpoint, and the host's own
// `endpoint.split("/")` throws before any route is reached — which is exactly
// how the panel shipped once looking permanently empty.
check(
  "client calls rpc.call with the /api channel as the first argument",
  /rpc\.call\(\s*"\/api"\s*,/.test(clientSource)
);
check(
  "client endpoint is a relative path with no leading slash",
  /rpc\.call\(\s*"\/api"\s*,\s*"skill-hub\/"\s*\+/.test(clientSource)
);

// Every colour must come from a theme token so the panel follows the active skin.
const hardcodedColours = (clientSource.match(/(?:^|[\s:(])(?:#[0-9a-fA-F]{3,8})\b/g) || []).filter(Boolean);
check(
  "client styles with theme tokens, not literal colours",
  hardcodedColours.length === 0,
  hardcodedColours.slice(0, 4).join(", ")
);

// ── 3. Sidebar glyph ─────────────────────────────────────────────────

const Icon = registrations.find((r) => r.options.name === "sidebar.panellist").Component;
for (const size of [16, 18, 20]) {
  const tree = Icon({ size, active: false });
  check(`glyph renders an svg at ${size}px`, tree.type === "svg" && tree.props.width === size);
}
const defaulted = Icon({});
check("glyph falls back to 16px", defaulted.props.width === 16);
check("glyph inherits colour", defaulted.props.stroke === "currentColor");

// ── 4. Host routes ───────────────────────────────────────────────────

const host = await import("../src/index.js");
check("host name", host.name === "dsh-skill-hub", host.name);
check("host injects connection + skills", JSON.stringify(host.inject) === JSON.stringify(["connection", "skills"]));

const routes = [];
// Point the skills root at a scratch directory: the uninstall route below really
// does rmSync when a slug passes validation, and it must never reach ~/.dsh.
const scratchSkills = mkdtempSync(join(tmpdir(), "dsh-skill-hub-test-"));
host.apply(
  { connection: { fetch: { register: (spec) => routes.push(spec) } }, skills: {} },
  { localSkillsDir: scratchSkills }
);

const expectedPaths = [
  "/api/skill-hub/categories",
  "/api/skill-hub/detail",
  "/api/skill-hub/experts",
  "/api/skill-hub/install",
  "/api/skill-hub/installed",
  "/api/skill-hub/search",
  "/api/skill-hub/sources",
  "/api/skill-hub/uninstall"
];
const actualPaths = routes.map((r) => r.path).sort();
check("eight RPC routes", JSON.stringify(actualPaths) === JSON.stringify(expectedPaths), JSON.stringify(actualPaths));
check("all routes POST only", routes.every((r) => JSON.stringify(r.methods) === JSON.stringify(["POST"])));
check("all routes have a fetch handler", routes.every((r) => typeof r.fetch === "function"));

const routeOf = (name) => routes.find((r) => r.path === `/api/skill-hub/${name}`);

const callRoute = async (name, payload) => {
  const res = await routeOf(name).fetch(
    new Request("http://x", { method: "POST", body: JSON.stringify({ rpcId: "t", payload: { args: payload } }) })
  );
  return res.json();
};

// GitHub was retired as a source (see README): the shipping pair is SkillHub
// plus ClawHub, and nothing else registers a searchable catalogue.

const searchRoute = routeOf("search");
const getResponse = await searchRoute.fetch(new Request("http://x/api/skill-hub/search", { method: "GET" }));
check("GET rejected with 404", getResponse.status === 404, String(getResponse.status));

const badBody = await searchRoute.fetch(
  new Request("http://x/api/skill-hub/search", { method: "POST", body: "not json" })
);
check("malformed body rejected with 400", badBody.status === 400, String(badBody.status));

// ── 5. Categories fall back to the built-in Chinese catalogue ─────────

const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("offline");
};

const categoriesOut = await callRoute("categories", {});
check("categories route still succeeds offline", categoriesOut.result?.ok === true);
const categoryList = categoriesOut.result?.value?.categories || [];
check("categories include an 'all' head", categoryList[0]?.key === "" && categoryList[0]?.name === "全部");
check("categories fall back to 12 built-ins plus the all-head", categoryList.length === 13, String(categoryList.length));
check(
  "built-in categories are Chinese",
  categoryList.some((entry) => entry.key === "dev-programming" && entry.name === "开发编程"),
  JSON.stringify(categoryList.slice(1, 3))
);
check(
  "the payment product line is not offered as a scenario category",
  !categoryList.some((entry) => entry.key === "pay-skill"),
  JSON.stringify(categoryList.map((entry) => entry.key))
);

// ── 6. A degraded source must not fail the search ────────────────────
//
// SkillHub answers, ClawHub throws, GitHub answers through jsDelivr. The
// request must resolve, keep the two healthy sources, and report the failure.

globalThis.fetch = async (url) => {
  const target = String(url);

  if (target.includes("api.skillhub.tencent.com/api/skills")) {
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          total: 1,
          skills: [
            {
              slug: "pdf",
              name: "PDF 工具",
              description: "work with pdf",
              description_zh: "处理 PDF 文件",
              downloads: 5000,
              stars: 12,
              verified: true,
              category: "office-efficiency",
              tags: ["pdf"],
              ownerName: "u_1",
              version: "1.0.0"
            }
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  if (target.includes("clawhub.ai")) {
    throw new Error("clawhub is unreachable");
  }

  if (target.includes("data.jsdelivr.com")) {
    return new Response(
      JSON.stringify({
        files: [
          { name: "/skills/pdf/SKILL.md" },
          { name: "/skills/pdf/helper.md" },
          { name: "/README.md" }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  throw new Error(`unexpected fetch: ${target}`);
};

const searchOut = await callRoute("search", { keyword: "", pageSize: 30 });
check("search resolves even with a dead source", searchOut.result?.ok === true, JSON.stringify(searchOut.result?.error));

const searchValue = searchOut.result?.value || {};
const foundSources = new Set((searchValue.items || []).map((item) => item.source));
check("SkillHub items survive", foundSources.has("skillhub"), JSON.stringify([...foundSources]));
check(
  "the dead source is reported, not hidden",
  (searchValue.errors || []).some((entry) => entry.source === "clawhub"),
  JSON.stringify(searchValue.errors)
);

check(
  "Chinese summary is preferred when present",
  (searchValue.items || []).some((item) => item.summaryZh === "处理 PDF 文件")
);

const sourcesOut = await callRoute("sources", {});
check("sources route lists the two shipping catalogues", (sourcesOut.result?.value?.sources || []).length === 2, JSON.stringify((sourcesOut.result?.value?.sources || []).map((entry) => entry.id)));
check(
  "SkillHub is the only category-aware source",
  (sourcesOut.result?.value?.sources || []).filter((entry) => entry.supportsCategory).map((entry) => entry.id).join(",") ===
    "skillhub"
);

// ── 6b. De-duplication across catalogues ─────────────────────────────
//
// The catalogues overlap heavily: SkillHub imports most of its rows from
// ClawHub, so the same skill routinely appears two or three times under
// different publishers. The index must collapse those into one row without
// collapsing two unrelated skills that merely share a generic slug.

const skillhubRow = (over) => ({
  slug: "agent-browser",
  name: "Agent Browser",
  description: "drive a browser",
  description_zh: "驱动浏览器",
  downloads: 100,
  ownerName: "u_1",
  namespace: { canonicalName: "@clawhub_rez0/agent-browser" },
  upstream_url: "https://clawhub.ai/rez0/agent-browser",
  ...over
});

globalThis.fetch = async (url) => {
  const target = String(url);

  if (target.includes("api.skillhub.tencent.com/api/skills")) {
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          total: 4,
          skills: [
            // Two publishers mirroring the *same* ClawHub skill.
            skillhubRow(),
            skillhubRow({ ownerName: "u_2", downloads: 50, namespace: { canonicalName: "@user_2/agent-browser" } }),
            // Same slug, different names, no upstream: two unrelated skills.
            skillhubRow({ slug: "github", name: "Github", ownerName: "u_3", downloads: 20, namespace: { canonicalName: "@u_3/github" }, upstream_url: "" }),
            skillhubRow({ slug: "github", name: "GitHub API", ownerName: "u_4", downloads: 10, namespace: { canonicalName: "@u_4/github" }, upstream_url: "" })
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  if (target.includes("clawhub.ai/api/v1/skills")) {
    return new Response(
      JSON.stringify({
        items: [
          // The original of the mirrored pair above.
          { ownerHandle: "rez0", slug: "agent-browser", displayName: "Agent Browser", stats: { downloads: 900 } }
        ],
        nextCursor: null
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  if (target.includes("data.jsdelivr.com")) {
    return new Response(JSON.stringify({ files: [{ name: "/skills/pdf/SKILL.md" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  if (target.includes("api.github.com")) throw new Error("no github token here");
  throw new Error(`unexpected fetch: ${target}`);
};

const dedupeOut = await callRoute("search", { keyword: "", pageSize: 30 });
const dedupeItems = dedupeOut.result?.value?.items || [];
const bySlug = (slug) => dedupeItems.filter((item) => item.slug === slug);

check(
  "a mirrored skill collapses to one row",
  bySlug("agent-browser").length === 1,
  JSON.stringify(bySlug("agent-browser").map((i) => i.source))
);
check(
  "the best-described copy is the one kept",
  bySlug("agent-browser")[0]?.source === "skillhub",
  JSON.stringify(bySlug("agent-browser").map((i) => i.source))
);
check(
  "two unrelated skills with a shared slug are both kept",
  bySlug("github").length === 2,
  JSON.stringify(bySlug("github").map((i) => i.name))
);

// ── 6c. A second install must not delete the first ───────────────────
//
// The install directory is the slug, and the catalogues share that namespace:
// SkillHub alone lists four different "agent-browser" skills by four owners.
// Installing used to rmSync whatever was already there, so installing the
// second one silently destroyed the first.

mkdirSync(join(scratchSkills, "agent-browser"), { recursive: true });
writeFileSync(join(scratchSkills, "agent-browser", "SKILL.md"), "---\nname: agent-browser\n---\nfirst\n");

const blocked = await callRoute("install", { source: "skillhub", slug: "agent-browser" });
check("install refuses to clobber an occupied directory", blocked.result?.ok === false, JSON.stringify(blocked.result));
check(
  "the refusal names the collision instead of failing silently",
  /占用/.test(blocked.result?.error?.message || ""),
  blocked.result?.error?.message
);

// With overwrite asked for, the collision guard must step aside — the request
// now gets as far as the download, which is what fails here.
const allowed = await callRoute("install", { source: "skillhub", slug: "agent-browser", overwrite: true });
check(
  "overwrite:true passes the collision guard",
  allowed.result?.ok === false && !/占用/.test(allowed.result?.error?.message || ""),
  allowed.result?.error?.message
);

// ── 6d. Experts are rewritten into loadable skills ───────────────────
//
// Upstream ships each role as a persona prompt with a Chinese `name:` in its
// frontmatter. The harness only accepts `^[a-z0-9]+(-[a-z0-9]+)*$` as a skill
// name and drops anything else, so the install path has to rewrite the file.
// These checks pin that behaviour: the ascii id becomes `name`, the Chinese
// display name survives in `description`, and the persona body is untouched.

const EXPERT_CATALOG = [
  "# 智能体速查表",
  "",
  "## 🛠️ 工程部 (2)",
  "",
  "| 中文名 | 文件路径 |",
  "|--------|----------|",
  "| 前端开发者 | `engineering/engineering-frontend-developer.md` |",
  "| 后端架构师 | `engineering/engineering-backend-architect.md` |",
  "",
  "## 📖 学术部 (1)",
  "",
  "| 中文名 | 文件路径 |",
  "|--------|----------|",
  "| 历史学家 | `academic/academic-historian.md` |"
].join("\n");

const EXPERT_ROSTER = [
  "| Agent ID | 中文名 | 描述 | 来源 |",
  "|----------|--------|------|------|",
  "| `engineering-frontend-developer` | 前端开发者 | 前端开发专家，精通 React | 翻译 |",
  "| `academic-historian` | 历史学家 | 历史研究专家 | 原创 |"
].join("\n");

const EXPERT_FILE = [
  "---",
  "name: 前端开发者",
  "description: 精通现代 Web 技术、UI 框架和性能优化",
  "emoji: 💻",
  "color: cyan",
  "---",
  "",
  "# 前端开发者 Agent 人格",
  "",
  "你是 **前端开发者**，一位精通现代 Web 技术的专家。"
].join("\n");

globalThis.fetch = async (url) => {
  const target = String(url);
  const serve = (body) => new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  if (target.includes("CATALOG.md")) return serve(EXPERT_CATALOG);
  if (target.includes("AGENT-LIST.md")) return serve(EXPERT_ROSTER);
  if (target.includes("engineering-frontend-developer.md")) return serve(EXPERT_FILE);
  return new Response("not found", { status: 404 });
};

const catalogOut = await callRoute("experts", {});
const catalogValue = catalogOut.result?.value || {};
check("experts route succeeds", catalogOut.result?.ok === true, JSON.stringify(catalogOut.result).slice(0, 160));
check("catalog lists every expert", catalogValue.total === 3, String(catalogValue.total));
check(
  "departments keep their ascii folder key and Chinese label",
  catalogValue.departments?.length === 2 &&
    catalogValue.departments[0].key === "engineering" &&
    catalogValue.departments[0].label === "工程部" &&
    catalogValue.departments[1].key === "academic",
  JSON.stringify(catalogValue.departments?.map((d) => [d.key, d.label]))
);
check(
  "the roster blurb is joined onto the matching expert",
  catalogValue.experts?.find((e) => e.stem === "engineering-frontend-developer")?.summary ===
    "前端开发专家，精通 React",
  JSON.stringify(catalogValue.experts?.map((e) => [e.stem, e.summary]))
);
check(
  "an expert missing from the roster still lists, without a blurb",
  catalogValue.experts?.find((e) => e.stem === "engineering-backend-architect")?.summary === ""
);

const expertDetail = await callRoute("detail", {
  source: "experts",
  slug: "engineering-frontend-developer",
  repoPath: "engineering/engineering-frontend-developer.md"
});
const expertMarkdown = expertDetail.result?.value?.readme || "";
const expertName = (expertMarkdown.match(/^name:\s*(.+)$/m) || [])[1] || "";
check(
  "the skill name is the ascii id, not the Chinese title",
  expertName === "engineering-frontend-developer",
  JSON.stringify(expertName)
);
check(
  "the generated name satisfies the harness name rule",
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(expertName),
  JSON.stringify(expertName)
);
check(
  "the Chinese display name survives in description",
  /^description:\s*.+前端开发者/m.test(expertMarkdown),
  (expertMarkdown.match(/^description:.*$/m) || [])[0]
);
check(
  "the persona body is preserved",
  expertMarkdown.includes("# 前端开发者 Agent 人格") && expertMarkdown.includes("精通现代 Web 技术的专家"),
  expertMarkdown.slice(0, 120)
);
check("the original Chinese name: line is gone", !/^name:\s*前端开发者$/m.test(expertMarkdown));

const expertInstall = await callRoute("install", {
  source: "experts",
  slug: "engineering-frontend-developer",
  repoPath: "engineering/engineering-frontend-developer.md"
});
check("expert install succeeds", expertInstall.result?.ok === true, JSON.stringify(expertInstall.result).slice(0, 200));

const writtenSkill = join(scratchSkills, "engineering-frontend-developer", "SKILL.md");
const writtenText = readFileSync(writtenSkill, "utf8");
check(
  "the installed SKILL.md carries the ascii name",
  /^name:\s*engineering-frontend-developer$/m.test(writtenText),
  (writtenText.match(/^name:.*$/m) || [])[0]
);
check("the installed SKILL.md keeps the persona body", writtenText.includes("前端开发者 Agent 人格"));

const expertSourcesOut = await callRoute("sources", {});
const sourceIds = (expertSourcesOut.result?.value?.sources || []).map((entry) => entry.id);
check(
  "experts stay out of keyword search sources",
  sourceIds.length === 2 && !sourceIds.includes("experts"),
  JSON.stringify(sourceIds)
);

globalThis.fetch = realFetch;

// ── 7. Markdown renderer ─────────────────────────────────────────────

const mdStart = clientSource.indexOf("function escapeHtml");
const mdEnd = clientSource.indexOf("    // ── api");
check("markdown block located", mdStart > 0 && mdEnd > mdStart);

const renderMarkdown = new Function(clientSource.slice(mdStart, mdEnd) + "\nreturn renderMarkdown;")();

const sample = [
  "---",
  "name: demo",
  "description: >-",
  "  folded line",
  "---",
  "",
  "# 标题",
  "",
  "一段**加粗**和*斜体*，行内 `code`，以及 [链接](https://example.com)。",
  "",
  "- 第一条",
  "- 第二条",
  "",
  "```bash",
  "run.sh",
  "```",
  "",
  "> 引用",
  "",
  "| 参数 | 说明 |",
  "| --- | --- |",
  "| `--a` | 甲 |",
  "",
  "---"
].join("\n");

const html = renderMarkdown(sample);

check("frontmatter dropped", !html.includes("name: demo") && !html.includes("folded line"));
check("heading", html.includes("<h1>标题</h1>"));
check("emphasis", html.includes("<strong>加粗</strong>") && html.includes("<em>斜体</em>"));
check("inline code", html.includes("<code>code</code>"));
check("link", html.includes('<a href="https://example.com"'));
check("code fence", html.includes("<pre><code>"));
check("list", html.includes("<ul>") && html.includes("<li>第一条</li>"));
check("blockquote", html.includes("<blockquote>"));
check("table", html.includes("<table>") && html.includes("<td><code>--a</code></td>"));
check("table separator dropped", !html.includes("<td>---</td>"));
check("horizontal rule", html.includes("<hr>"));

for (const tag of ["p", "ul", "li", "table", "tr", "td", "pre", "code", "strong", "em", "h1", "blockquote"]) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
  check(`<${tag}> balanced`, open === close, `${open} open / ${close} close`);
}

const hostile = renderMarkdown('<script>alert(1)</script> & "q"');
check("html escaped", !hostile.includes("<script>") && hostile.includes("&lt;script&gt;"));

// A readme is remote content, so an executable URL must not survive as a link.
for (const bad of [
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD4=)",
  "[x](vbscript:msgbox)",
  "![i](javascript:alert(1))"
]) {
  const out = renderMarkdown(bad);
  check(`drops unsafe url: ${bad}`, !/javascript:|vbscript:|data:/i.test(out), out);
}
check("keeps https links", /href="https:\/\/example\.com"/.test(renderMarkdown("[a](https://example.com)")));
check("keeps relative links", /href="\.\/docs\/a\.md"/.test(renderMarkdown("[a](./docs/a.md)")));
check("keeps anchors", /href="#install"/.test(renderMarkdown("[a](#install)")));

// ── 8. Path containment ──────────────────────────────────────────────
//
// install/uninstall build a directory from `slug` and then rmSync it, and the
// slug comes from the RPC payload and the remote catalogue. A traversing value
// would let a request delete anything the host can reach, so exercise the guard
// through the public route rather than trusting inspection.

for (const evil of ["..", ".", "../escape", "..\\escape", "a/b", "a\\b", "C:evil", "", "   "]) {
  const out = await callRoute("uninstall", { slug: evil });
  check(`uninstall rejects slug ${JSON.stringify(evil)}`, out.result?.ok === false, JSON.stringify(out.result));
}

// A well-formed slug must still reach the normal path (and here fail only
// because nothing is installed), proving the guard is not a blanket refusal.
const normal = await callRoute("uninstall", { slug: "some-real-skill" });
check(
  "uninstall still handles a normal slug",
  normal.result?.ok === false && /尚未安装|not installed/i.test(normal.result.error.message),
  JSON.stringify(normal.result)
);

const installEvil = await callRoute("install", { source: "skillhub", slug: "../escape" });
check("install rejects a traversing slug", installEvil.result?.ok === false, JSON.stringify(installEvil.result));

const installNoSource = await callRoute("install", { slug: "pdf" });
check("install requires a source", installNoSource.result?.ok === false, JSON.stringify(installNoSource.result));

const detailNoSource = await callRoute("detail", { slug: "pdf" });
check("detail requires a source", detailNoSource.result?.ok === false, JSON.stringify(detailNoSource.result));

// ── Result ───────────────────────────────────────────────────────────

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
