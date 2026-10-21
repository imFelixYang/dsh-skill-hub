// Live smoke test — hits the real catalogues. Requires network.
//
//   node test/live.mjs              # every source, no keyword
//   node test/live.mjs "pdf"        # every source, one keyword
//
// This is opt-in and separate from `test/verify.mjs`, which stays offline.
// It exists because the registries' field names are not ours to control: a
// rename upstream has to be caught here, not by a user.
//
// Installs are isolated to a throwaway directory, so $DSH_HOME/skills is never
// touched. Timings are printed so a source that quietly became slow shows up.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "../src/index.js";

const keyword = process.argv[2] || "";

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

const sandbox = mkdtempSync(join(tmpdir(), "dsh-skill-hub-live-"));
console.log(`sandbox: ${sandbox}`);
console.log(`keyword: ${keyword ? JSON.stringify(keyword) : "(none)"}\n`);

const routes = [];
host.apply(
  {
    connection: { fetch: { register: (spec) => routes.push(spec) } },
    skills: { list: async () => [] }
  },
  { localSkillsDir: sandbox }
);

async function call(endpoint, args) {
  const route = routes.find((r) => r.path === `/api/skill-hub/${endpoint}`);
  if (!route) throw new Error(`no route for ${endpoint}`);
  const started = Date.now();
  const response = await route.fetch(
    new Request(`http://x/api/skill-hub/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rpcId: "live", payload: { args } })
    })
  );
  const envelope = await response.json();
  if (envelope.type !== "server-response") throw new Error("bad RPC envelope");
  if (envelope.rpcId !== "live") throw new Error("rpcId not echoed");
  return { ms: Date.now() - started, result: envelope.result };
}

/** Build the detail/install reference for a search item. */
const refOf = (item) => ({
  source: item.source,
  slug: item.slug,
  owner: item.owner,
  repoRef: item.repoRef,
  repoPath: item.repoPath
});

try {
  // ── sources ────────────────────────────────────────────────────────────
  const sources = await call("sources", {});
  check("sources succeeds", sources.result.ok === true, JSON.stringify(sources.result.error));
  const sourceIds = sources.result.ok ? sources.result.value.sources.map((s) => s.id) : [];
  check("the shipping pair is registered", sourceIds.length === 2, sourceIds.join(","));

  // ── categories ─────────────────────────────────────────────────────────
  const categories = await call("categories", {});
  check("categories succeeds", categories.result.ok === true, `${categories.ms}ms`);
  if (categories.result.ok) {
    const list = categories.result.value.categories;
    check("categories populated", list.length > 1, `${list.length} entries`);
    console.log(`      ${list.slice(1, 6).map((c) => `${c.name}(${c.key})`).join(" / ")}`);
  }

  // ── each source on its own ─────────────────────────────────────────────
  const samples = {};

  for (const source of sourceIds) {
    const out = await call("search", { keyword, pageSize: 8, source });
    if (!check(`search[${source}] succeeds`, out.result.ok === true, JSON.stringify(out.result.error))) continue;

    const value = out.result.value;
    check(`search[${source}] returns items`, value.items.length > 0, `${value.items.length} items in ${out.ms}ms`);
    if (value.items.length) {
      samples[source] = value.items[0];
      console.log(
        `      ${value.items
          .slice(0, 3)
          .map((item) => `${item.name} [${item.slug}]`)
          .join(" | ")}`
      );
    }
  }

  // ── all sources at once: the concurrency claim ─────────────────────────
  const all = await call("search", { keyword, pageSize: 10 });
  check("search[all] succeeds", all.result.ok === true, JSON.stringify(all.result.error));
  if (all.result.ok) {
    const value = all.result.value;
    const bySource = {};
    for (const item of value.items) bySource[item.source] = (bySource[item.source] || 0) + 1;
    // SkillHub mirrors ClawHub, so an all-sources page may legitimately come
    // back single-sourced once duplicates collapse. Same-slug entries with
    // different names are genuinely different skills (one slug, many authors),
    // so only an exact repeat counts as a duplicate.
    const keys = value.items.map((item) => `${item.source}|${item.slug}|${item.name}`);
    check(
      "search[all] returns unique entries",
      value.items.length > 0 && new Set(keys).size === keys.length,
      JSON.stringify(bySource)
    );
    check(
      "search[all] finishes near the slowest source",
      all.ms < 9000,
      `${all.ms}ms (serial SkillHub+ClawHub was ~6200ms before the rewrite)`
    );
    if (value.errors.length) {
      console.log(`      degraded: ${value.errors.map((e) => `${e.source} → ${e.error}`).join("; ")}`);
    }
  }

  // ── detail + install round trip, one per source ────────────────────────
  for (const [source, item] of Object.entries(samples)) {
    const detail = await call("detail", refOf(item));
    if (check(`detail[${source}] succeeds`, detail.result.ok === true, JSON.stringify(detail.result.error))) {
      const value = detail.result.value;
      check(`detail[${source}] carries a readme`, (value.readme || "").length > 0, `${(value.readme || "").length} chars in ${detail.ms}ms`);
    }

    const install = await call("install", refOf(item));
    if (!check(`install[${source}] succeeds`, install.result.ok === true, JSON.stringify(install.result.error))) continue;

    const slug = install.result.value.slug;
    const target = join(sandbox, slug);
    check(`install[${source}] produced SKILL.md`, existsSync(join(target, "SKILL.md")), slug);
    if (existsSync(target)) {
      const files = readdirSync(target);
      console.log(`      files: ${files.slice(0, 6).join(", ")}${files.length > 6 ? `, +${files.length - 6}` : ""}`);
      if (existsSync(join(target, "SKILL.md"))) {
        const text = readFileSync(join(target, "SKILL.md"), "utf8");
        check(`install[${source}] SKILL.md is non-empty`, text.length > 0, `${text.length} chars`);
      }
    }

    const listed = await call("installed", {});
    check(
      `installed lists ${source} skill`,
      listed.result.ok === true && (listed.result.value.skills || []).some((s) => s.slug === slug),
      slug
    );

    const removed = await call("uninstall", { slug });
    check(`uninstall[${source}] succeeds`, removed.result.ok === true, JSON.stringify(removed.result.error));
    check(`uninstall[${source}] removed the directory`, !existsSync(target), slug);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("");
if (failures) {
  console.log(`${failures} live check(s) failed`);
  process.exit(1);
}
console.log("All live checks passed.");
