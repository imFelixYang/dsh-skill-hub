// Live verification for dsh-skill-hub — requires network.
//
//   node test/live.mjs
//
// Drives the host half's RPC handlers directly (no browser) against the real
// registries:
//
//   1. search returns merged SkillHub + ClawHub results;
//   2. detail returns a rendered-able README;
//   3. install unpacks a real published archive into a temp directory, the
//      result contains SKILL.md, and uninstall removes it again;
//   4. categories returns the SkillHub category list.
//
// Installs are isolated to a throwaway directory; your real $DSH_HOME/skills is
// never touched.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "../src/index.js";

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

const sandbox = mkdtempSync(join(tmpdir(), "dsh-skill-hub-live-"));
console.log(`sandbox: ${sandbox}\n`);

const routes = [];
host.apply(
  {
    connection: { fetch: { register: (spec) => routes.push(spec) } },
    skills: { list: async () => [], get: () => undefined },
  },
  { localSkillsDir: sandbox }
);

async function call(endpoint, args) {
  const route = routes.find((r) => r.path === `/api/skill-hub/${endpoint}`);
  if (!route) throw new Error(`no route for ${endpoint}`);
  const response = await route.fetch(
    new Request(`http://x/api/skill-hub/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rpcId: "verify", payload: { args } }),
    })
  );
  const envelope = await response.json();
  if (envelope.type !== "server-response") throw new Error("bad RPC envelope");
  if (envelope.rpcId !== "verify") throw new Error("rpcId not echoed");
  return envelope.result;
}

try {
  // 1. search
  const search = await call("search", { keyword: "pdf", page: 1, pageSize: 6 });
  check("search succeeds", search.ok === true, JSON.stringify(search.error));
  if (search.ok) {
    const { items, sources, errors } = search.value;
    console.log(`      sources=${JSON.stringify(sources)} errors=${JSON.stringify(errors)}`);
    check("search returns items", items.length > 0, String(items.length));
    check(
      "items carry a source and a slug",
      items.every((it) => typeof it.slug === "string" && typeof it.source === "string")
    );
    for (const it of items.slice(0, 5)) {
      console.log(`      - [${it.source}] ${it.slug}`);
    }
  }

  // 2. detail
  const list = await call("search", { keyword: "pdf", page: 1, pageSize: 1 });
  const first = list.ok && list.value.items[0];
  if (check("found a skill to inspect", !!first)) {
    const detail = await call("detail", { slug: first.slug, source: first.source });
    check("detail succeeds", detail.ok === true, JSON.stringify(detail.error));
    if (detail.ok) {
      check("detail carries a readme", (detail.value.readme || "").length > 0);
      console.log(`      detail: ${detail.value.displayName || detail.value.name} (${detail.value.source})`);
    }

    // 3. install / readme / uninstall
    const install = await call("install", { slug: first.slug, source: first.source });
    check("install succeeds", install.ok === true, JSON.stringify(install.error));

    if (install.ok) {
      const target = join(sandbox, first.slug);
      check("SKILL.md extracted", existsSync(join(target, "SKILL.md")));
      if (existsSync(target)) {
        console.log(`      files: ${readdirSync(target).slice(0, 6).join(", ")}`);
        if (existsSync(join(target, "SKILL.md"))) {
          const text = readFileSync(join(target, "SKILL.md"), "utf8");
          check("SKILL.md is non-empty", text.length > 0, `${text.length} chars`);
        }
      }

      const installed = await call("installed", {});
      check(
        "installed list includes it",
        installed.ok && (installed.value.skills || []).some((s) => (s.slug || s.name) === first.slug)
      );

      const readme = await call("readme", { slug: first.slug });
      check("readme readable", readme.ok === true, JSON.stringify(readme.error));

      const uninstall = await call("uninstall", { slug: first.slug });
      check("uninstall succeeds", uninstall.ok === true, JSON.stringify(uninstall.error));
      check("directory removed", !existsSync(target));
    }
  }

  // 4. categories
  const categories = await call("categories", {});
  check("categories succeed", categories.ok === true, JSON.stringify(categories.error));
  if (categories.ok) {
    const count = (categories.value.categories || []).length;
    check("categories are populated", count > 0, String(count));
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("");
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All live checks passed.");
