// Offline verification for dsh-skill-hub.
//
//   node test/verify.mjs
//
// Runs without network and without a browser. It checks the parts that are
// checkable in isolation:
//
//   1. both halves parse as ES modules;
//   2. the client half loads through the same `window.__ModuleLoader__` shim
//      the DSH web shell uses, and claims exactly three documented seats;
//   3. the sidebar glyph honours the `size` prop the shell passes;
//   4. the host half registers exactly the seven documented RPC routes, POST
//      only, and answers GET → 404 / bad body → 400 before touching the network;
//   5. the markdown renderer escapes HTML and produces balanced tags.
//
// Visual behaviour (row alignment, theme colours) is verified by installing the
// bundle into DSH — see the README.

import { readFileSync } from "node:fs";

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
  },
};

const loads = [];
globalThis.window = {
  __ModuleLoader__: { load: (mod) => loads.push(mod) },
  setTimeout: () => 0,
  clearTimeout: () => {},
  confirm: () => true,
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.AbortController = class {
  constructor() {
    this.signal = {};
  }
};
globalThis.CustomEvent = class {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
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
  },
};

const rpc = { call: async () => ({ ok: true, value: { items: [], skills: [], categories: [] } }) };
const ctx = {
  slots,
  get(name) {
    if (name !== "connection") throw new Error(`unexpected service: ${name}`);
    return { rpc };
  },
  effect(fn, label) {
    effects.push(label);
    return fn();
  },
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
host.apply({ connection: { fetch: { register: (spec) => routes.push(spec) } }, skills: {} }, {});

const expectedPaths = [
  "/api/skill-hub/categories",
  "/api/skill-hub/detail",
  "/api/skill-hub/install",
  "/api/skill-hub/installed",
  "/api/skill-hub/readme",
  "/api/skill-hub/search",
  "/api/skill-hub/uninstall",
];
const actualPaths = routes.map((r) => r.path).sort();
check("seven RPC routes", JSON.stringify(actualPaths) === JSON.stringify(expectedPaths), JSON.stringify(actualPaths));
check("all routes POST only", routes.every((r) => JSON.stringify(r.methods) === JSON.stringify(["POST"])));
check("all routes have a fetch handler", routes.every((r) => typeof r.fetch === "function"));

const search = routes.find((r) => r.path === "/api/skill-hub/search");
const getResponse = await search.fetch(new Request("http://x/api/skill-hub/search", { method: "GET" }));
check("GET rejected with 404", getResponse.status === 404, String(getResponse.status));

const badBody = await search.fetch(
  new Request("http://x/api/skill-hub/search", { method: "POST", body: "not json" })
);
check("malformed body rejected with 400", badBody.status === 400, String(badBody.status));

// ── 5. Markdown renderer ─────────────────────────────────────────────

const mdStart = clientSource.indexOf("function escapeHtml");
const mdEnd = clientSource.indexOf("    // ── API helper");
check("markdown block located", mdStart > 0 && mdEnd > mdStart);

const renderMarkdown = new Function(
  clientSource.slice(mdStart, mdEnd) + "\nreturn renderMarkdown;"
)();

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
  "---",
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
check("horizontal rule", html.includes("<hr/>"));

for (const tag of ["p", "ul", "li", "table", "tr", "td", "pre", "code", "strong", "em", "h1", "blockquote"]) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
  check(`<${tag}> balanced`, open === close, `${open} open / ${close} close`);
}

const hostile = renderMarkdown('<script>alert(1)</script> & "q"');
check("html escaped", !hostile.includes("<script>") && hostile.includes("&lt;script&gt;"));

// ── Result ───────────────────────────────────────────────────────────

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
