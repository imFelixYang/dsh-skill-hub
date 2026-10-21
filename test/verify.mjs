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
  "/api/skill-hub/install",
  "/api/skill-hub/installed",
  "/api/skill-hub/search",
  "/api/skill-hub/sources",
  "/api/skill-hub/uninstall"
];
const actualPaths = routes.map((r) => r.path).sort();
check("seven RPC routes", JSON.stringify(actualPaths) === JSON.stringify(expectedPaths), JSON.stringify(actualPaths));
check("all routes POST only", routes.every((r) => JSON.stringify(r.methods) === JSON.stringify(["POST"])));
check("all routes have a fetch handler", routes.every((r) => typeof r.fetch === "function"));

const routeOf = (name) => routes.find((r) => r.path === `/api/skill-hub/${name}`);

const callRoute = async (name, payload) => {
  const res = await routeOf(name).fetch(
    new Request("http://x", { method: "POST", body: JSON.stringify({ rpcId: "t", payload: { args: payload } }) })
  );
  return res.json();
};

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
check("categories fall back to 13 built-ins", categoryList.length === 14, String(categoryList.length));
check(
  "built-in categories are Chinese",
  categoryList.some((entry) => entry.key === "dev-programming" && entry.name === "开发编程"),
  JSON.stringify(categoryList.slice(1, 3))
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
check("GitHub items survive", foundSources.has("github"), JSON.stringify([...foundSources]));
check(
  "the dead source is reported, not hidden",
  (searchValue.errors || []).some((entry) => entry.source === "clawhub"),
  JSON.stringify(searchValue.errors)
);

const githubItem = (searchValue.items || []).find((item) => item.source === "github");
check("GitHub item carries the fields install needs", !!githubItem && !!githubItem.owner && !!githubItem.repoPath && !!githubItem.repoRef, JSON.stringify(githubItem));
check("GitHub install slug is a single safe segment", !!githubItem && !/[\\/]/.test(githubItem.slug), githubItem?.slug);
check(
  "Chinese summary is preferred when present",
  (searchValue.items || []).some((item) => item.summaryZh === "处理 PDF 文件")
);

const sourcesOut = await callRoute("sources", {});
check("sources route lists three catalogues", (sourcesOut.result?.value?.sources || []).length === 3);
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
check(
  "the de-duplicated list still carries the GitHub row",
  dedupeItems.some((item) => item.source === "github")
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
