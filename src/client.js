/**
 * dsh-skill-hub — Client half
 *
 * Aggregated skill hub: search SkillHub + ClawHub in one place, preview a
 * skill's README, install / uninstall it into $DSH_HOME/skills.
 *
 * This half only claims official seats:
 *   - `sidebar.panellist` — the row in the shell's own panel list
 *   - `main`              — the page that row switches the centre column to
 *   - `conversation.input.left` — a convenience picker next to the composer
 *
 * It never touches the host's DOM: no injected sidebar rows, no brand swaps,
 * no renaming of built-in entries. The shell owns row geometry, label colour,
 * hover, the collapsed rail and the panel switch, so the row lines up with
 * its neighbours by construction.
 *
 * Styling uses only `--dsw-alias-*` theme tokens, so the plugin follows
 * whatever theme is active (built-in, OpenCode palette, custom skin).
 */

window.__ModuleLoader__.load({
  id: "dsh-skill-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var PANEL_ID = "skill-hub";
    var PANEL_ORDER = -1;
    var INPUT_ORDER = 100;

    // ── Locale ───────────────────────────────────────────────────────
    //
    // Visible text goes through the host's locale service, registered in
    // `apply`. The table below is also the offline fallback, so the panel
    // still renders if the shell has no locale service.

    var NS = "dsh-skill-hub";

    var DICT = {
      zh: {
        "page.title": "技能中心",
        "page.searchPlaceholder": "搜索技能（SkillHub + ClawHub）",
        "page.sourceTitle": "搜索来源",
        "tab.market": "技能市场",
        "tab.installed": "已安装",
        "cat.all": "全部分类",
        "src.all": "全部来源",
        "src.local": "本地",
        "stat.downloads": "下载 {n}",
        "stat.stars": "收藏 {n}",
        "stat.wan": "万",
        "meta.version": "版本 v{v}",
        "meta.author": "作者 {a}",
        "section.readme": "说明",
        "btn.detail": "详情",
        "btn.install": "安装",
        "btn.uninstall": "卸载",
        "btn.back": "← 返回",
        "badge.installed": "已安装",
        "state.loading": "加载中…",
        "state.searching": "正在搜索…",
        "state.empty": "没有可显示的内容",
        "state.noResults": "没有找到匹配的技能",
        "state.noInstalled": "还没有安装任何技能",
        "state.noReadme": "这个技能没有附带说明文档",
        "err.request": "请求失败",
        "err.detail": "加载详情失败: {e}",
        "err.install": "安装失败: {e}",
        "err.uninstall": "卸载失败: {e}",
        "toast.installed": "已安装 {name}",
        "toast.uninstalled": "已卸载 {name}",
        "confirm.uninstall": "确定要卸载「{name}」吗？",
        "picker.button": "技能",
        "picker.title": "选择要插入的技能",
        "picker.filter": "筛选已安装技能…",
        "picker.noMatch": "没有匹配的技能",
        "picker.empty": "还没有安装技能",
      },
      en: {
        "page.title": "Skill Hub",
        "page.searchPlaceholder": "Search skills (SkillHub + ClawHub)",
        "page.sourceTitle": "Search source",
        "tab.market": "Market",
        "tab.installed": "Installed",
        "cat.all": "All categories",
        "src.all": "All sources",
        "src.local": "Local",
        "stat.downloads": "{n} downloads",
        "stat.stars": "{n} stars",
        "stat.wan": "万",
        "meta.version": "v{v}",
        "meta.author": "by {a}",
        "section.readme": "About",
        "btn.detail": "Details",
        "btn.install": "Install",
        "btn.uninstall": "Uninstall",
        "btn.back": "← Back",
        "badge.installed": "Installed",
        "state.loading": "Loading…",
        "state.searching": "Searching…",
        "state.empty": "Nothing to show",
        "state.noResults": "No matching skills",
        "state.noInstalled": "No skills installed yet",
        "state.noReadme": "This skill ships no documentation",
        "err.request": "Request failed",
        "err.detail": "Could not load details: {e}",
        "err.install": "Install failed: {e}",
        "err.uninstall": "Uninstall failed: {e}",
        "toast.installed": "Installed {name}",
        "toast.uninstalled": "Uninstalled {name}",
        "confirm.uninstall": "Uninstall “{name}”?",
        "picker.button": "Skills",
        "picker.title": "Insert a skill",
        "picker.filter": "Filter installed skills…",
        "picker.noMatch": "No matching skills",
        "picker.empty": "No skills installed yet",
      },
    };

    function detectLocale() {
      try {
        var lang = (document && document.documentElement && document.documentElement.lang) || "";
        if (/^en(?:-|$)/i.test(lang)) return "en";
      } catch (e) { /* not a browser */ }
      return "zh";
    }

    var currentLocale = detectLocale();

    function t(key, params) {
      var table = DICT[currentLocale] || DICT.zh;
      var text = table[key];
      if (text === undefined) text = DICT.zh[key];
      if (text === undefined) return key;
      if (params) {
        Object.keys(params).forEach(function (name) {
          text = String(text).split("{" + name + "}").join(String(params[name]));
        });
      }
      return text;
    }

    // ── Styles ───────────────────────────────────────────────────────

    var CSS = [
      // Shell page frame: fill the centre column the shell hands us.
      ".dsh-sh-root{display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base,#1a1a2e);color:var(--dsw-alias-label-primary,#e0e0e0);font-size:14px;line-height:1.5}",

      // Header
      ".dsh-sh-head{display:flex;align-items:center;gap:12px;flex:none;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08))}",
      ".dsh-sh-title{margin:0;font-size:16px;font-weight:600;white-space:nowrap}",
      ".dsh-sh-search{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:34px;box-sizing:border-box;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,0.12))}",
      ".dsh-sh-search:focus-within{border-color:var(--dsw-alias-brand-primary,#818cf8)}",
      ".dsh-sh-search input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:inherit;font:inherit}",
      ".dsh-sh-search input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
      ".dsh-sh-src{flex:none;height:34px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,0.12));color:inherit;font:inherit;outline:none;cursor:pointer}",

      // Tabs
      ".dsh-sh-tabs{display:flex;gap:4px;flex:none;padding:8px 20px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08))}",
      ".dsh-sh-tab{box-sizing:border-box;padding:6px 12px 8px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#a0a0a0);font:inherit;cursor:pointer;white-space:nowrap}",
      ".dsh-sh-tab:hover{color:var(--dsw-alias-label-primary,#e0e0e0)}",
      ".dsh-sh-tab[data-active]{color:var(--dsw-alias-label-primary,#e0e0e0);border-bottom-color:var(--dsw-alias-brand-primary,#818cf8);font-weight:600}",

      // Body: category rail + content
      ".dsh-sh-body{display:flex;flex:1;min-height:0}",
      ".dsh-sh-rail{display:flex;flex-direction:column;gap:2px;flex:none;width:150px;box-sizing:border-box;padding:10px 8px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08))}",
      ".dsh-sh-rail button{box-sizing:border-box;width:100%;padding:6px 10px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary,#a0a0a0);font:inherit;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-sh-rail button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.12));color:var(--dsw-alias-label-primary,#e0e0e0)}",
      ".dsh-sh-rail button[data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.12));color:var(--dsw-alias-label-primary,#e0e0e0);font-weight:600}",
      ".dsh-sh-content{flex:1;min-width:0;overflow-y:auto;padding:12px 20px 24px}",

      // Card grid
      ".dsh-sh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}",
      ".dsh-sh-card{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,0.08));min-width:0}",
      ".dsh-sh-card:hover{border-color:var(--dsw-alias-border-l2,rgba(255,255,255,0.2))}",
      ".dsh-sh-card-head{display:flex;align-items:flex-start;gap:8px;min-width:0}",
      ".dsh-sh-card-title{margin:0;font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sh-card-desc{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#a0a0a0);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
      ".dsh-sh-card-stats{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);flex-wrap:wrap}",
      ".dsh-sh-card-actions{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:4px}",

      // Buttons
      ".dsh-sh-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.12));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-button-elevated-fill,rgba(128,128,128,0.1));color:var(--dsw-alias-label-primary,#e0e0e0);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}",
      ".dsh-sh-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.18))}",
      ".dsh-sh-btn:disabled{opacity:.5;cursor:default}",
      ".dsh-sh-btn[data-kind=primary]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#818cf8));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".dsh-sh-btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary,#f87171);border-color:var(--dsw-alias-state-error-primary,rgba(248,113,113,.4))}",

      // Badges / tags
      ".dsh-sh-badge{display:inline-flex;align-items:center;flex:none;padding:1px 6px;border-radius:4px;font-size:11px;line-height:16px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.12));color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap}",
      ".dsh-sh-badge[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#4ade80);border-color:var(--dsw-alias-state-success-primary,rgba(74,222,128,.35))}",
      ".dsh-sh-badge[data-tone=brand]{color:var(--dsw-alias-brand-primary,#818cf8);border-color:var(--dsw-alias-brand-primary,rgba(129,140,248,.35))}",

      // Installed list
      ".dsh-sh-list{display:flex;flex-direction:column;gap:8px}",
      ".dsh-sh-row{display:flex;align-items:center;gap:12px;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,0.08));min-width:0}",
      ".dsh-sh-row-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}",
      ".dsh-sh-row-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sh-row-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#a0a0a0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",

      // Detail
      ".dsh-sh-detail{display:flex;flex-direction:column;gap:14px;max-width:900px}",
      ".dsh-sh-detail-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}",
      ".dsh-sh-detail-title{margin:0;font-size:18px;font-weight:600;min-width:0}",
      ".dsh-sh-detail-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#a0a0a0)}",
      ".dsh-sh-detail-meta{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
      ".dsh-sh-detail-tags{display:flex;gap:6px;flex-wrap:wrap}",
      ".dsh-sh-section-title{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#a0a0a0)}",

      // Rendered README
      ".dsh-sh-md{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,0.06));padding:14px 16px;overflow-wrap:anywhere}",
      ".dsh-sh-md h1,.dsh-sh-md h2,.dsh-sh-md h3{margin:16px 0 8px;line-height:1.3}",
      ".dsh-sh-md h1:first-child,.dsh-sh-md h2:first-child,.dsh-sh-md h3:first-child{margin-top:0}",
      ".dsh-sh-md h1{font-size:20px}.dsh-sh-md h2{font-size:17px}.dsh-sh-md h3{font-size:15px}",
      ".dsh-sh-md p{margin:8px 0}",
      ".dsh-sh-md ul{margin:8px 0;padding-left:22px}",
      ".dsh-sh-md li{margin:3px 0}",
      ".dsh-sh-md a{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary,#818cf8));text-decoration:none}",
      ".dsh-sh-md a:hover{text-decoration:underline}",
      ".dsh-sh-md code{padding:1px 5px;border-radius:4px;background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,0.18));font-size:12px;font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".dsh-sh-md pre{margin:10px 0;padding:12px;overflow-x:auto;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,0.18))}",
      ".dsh-sh-md pre code{padding:0;background:transparent}",
      ".dsh-sh-md blockquote{margin:10px 0;padding:2px 12px;border-left:3px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.2));color:var(--dsw-alias-label-secondary,#a0a0a0)}",
      ".dsh-sh-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));margin:14px 0}",
      ".dsh-sh-md table{border-collapse:collapse;margin:10px 0;font-size:13px}",
      ".dsh-sh-md td{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));padding:5px 9px}",
      ".dsh-sh-md img{max-width:100%;height:auto}",

      // States
      ".dsh-sh-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:48px 16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:13px;text-align:center}",
      ".dsh-sh-error{margin:0 0 12px;padding:8px 12px;border:1px solid var(--dsw-alias-state-error-primary,rgba(248,113,113,.4));border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-state-error-primary,#f87171);font-size:12px}",
      ".dsh-sh-spin{display:inline-block;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2));border-top-color:var(--dsw-alias-brand-primary,#818cf8);border-radius:50%;animation:dsh-sh-spin .7s linear infinite}",
      "@keyframes dsh-sh-spin{to{transform:rotate(360deg)}}",
      ".dsh-sh-loading{display:flex;align-items:center;gap:8px;padding:24px 0;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:13px}",

      // Toast
      ".dsh-sh-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;padding:9px 16px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:var(--dsw-alias-toast-bg,rgba(40,40,40,.96));color:var(--dsw-alias-toast-label,var(--dsw-alias-label-primary,#e0e0e0));font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none}",
      ".dsh-sh-toast[data-tone=error]{border-color:var(--dsw-alias-state-error-primary,rgba(248,113,113,.5))}",

      // Composer picker
      ".dsh-sh-picker-wrap{position:relative;display:inline-flex}",
      ".dsh-sh-picker{position:absolute;left:0;bottom:calc(100% + 6px);z-index:60;display:flex;flex-direction:column;width:260px;max-height:320px;box-sizing:border-box;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,#3c3836);box-shadow:0 12px 32px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary,#e0e0e0)}",
      ".dsh-sh-picker-head{flex:none;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
      ".dsh-sh-picker-head input{box-sizing:border-box;width:100%;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:6px;background:var(--dsw-alias-bg-base,#282828);color:inherit;font:inherit;font-size:12px;outline:none}",
      ".dsh-sh-picker-list{flex:1;min-height:0;overflow-y:auto;padding:4px}",
      ".dsh-sh-picker-item{display:flex;flex-direction:column;gap:1px;box-sizing:border-box;width:100%;padding:6px 8px;border:none;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dsh-sh-picker-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}",
      ".dsh-sh-picker-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sh-picker-desc{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ].join("\n");

    function Styles() {
      return h("style", { "data-dsh-skill-hub": "" }, CSS);
    }

    // ── Markdown (small, self-contained) ─────────────────────────────

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function renderMarkdown(md) {
      if (!md) return "";
      var lines = String(md).split("\n");
      // Drop YAML frontmatter
      if (lines[0] && lines[0].trim() === "---") {
        for (var i = 1; i < lines.length; i++) {
          if (lines[i].trim() === "---") { lines = lines.slice(i + 1); break; }
        }
      }
      var text = escapeHtml(lines.join("\n"));

      text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (m, lang, code) {
        return "<pre><code>" + code.replace(/\n$/, "") + "</code></pre>";
      });
      text = text.replace(/`([^`\n]+)`/g, function (m, code) { return "<code>" + code + "</code>"; });
      text = text.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
      text = text.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
      text = text.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");
      text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" />');
      text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      text = text.replace(/^&gt;\s+(.+)$/gm, "<blockquote>$1</blockquote>");
      text = text.replace(/^---$/gm, "<hr/>");

      // Tables: group consecutive rows, drop the separator row
      text = text.replace(/(?:^\|.*\|$\n?)+/gm, function (block) {
        var rows = block.trim().split("\n").map(function (row) {
          return row.replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
        }).filter(function (cells) {
          return !cells.every(function (c) { return /^:?-{2,}:?$/.test(c); });
        });
        if (!rows.length) return "";
        return "<table>" + rows.map(function (cells) {
          return "<tr>" + cells.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
        }).join("") + "</table>";
      });

      text = text.replace(/^(?:[*\-]\s+.+\n?)+/gm, function (block) {
        var items = block.trim().split("\n").map(function (line) {
          return "<li>" + line.replace(/^[*\-]\s+/, "") + "</li>";
        });
        return "<ul>" + items.join("") + "</ul>";
      });

      text = text.split(/\n{2,}/).map(function (chunk) {
        if (!chunk.trim()) return "";
        if (/^<(h1|h2|h3|ul|ol|pre|table|blockquote|hr)/i.test(chunk.trim())) return chunk;
        return "<p>" + chunk.replace(/\n/g, "<br/>") + "</p>";
      }).join("\n");

      return text;
    }

    // ── API helper ───────────────────────────────────────────────────

    function makeApi(rpc) {
      return {
        call: function (endpoint, payload) {
          var controller = new AbortController();
          return rpc.call("/api", endpoint, payload || {}, controller.signal).then(function (result) {
            if (!result || !result.ok) {
              var message = result && result.error && result.error.message;
              throw new Error(message || t("err.request"));
            }
            return result.value;
          });
        },
      };
    }

    // ── Small pieces ─────────────────────────────────────────────────

    function Spinner() {
      return h("span", { className: "dsh-sh-spin", "aria-hidden": "true" });
    }

    function Toast(_a) {
      var message = _a.message, tone = _a.tone;
      if (!message) return null;
      return h("div", { className: "dsh-sh-toast", "data-tone": tone || "info", role: "status" }, message);
    }

    function sourceLabel(source) {
      if (source === "skillhub") return "SkillHub";
      if (source === "clawhub") return "ClawHub";
      if (source === "local") return t("src.local");
      return source || "";
    }

    function formatCount(n) {
      var value = Number(n);
      if (!isFinite(value) || value <= 0) return "";
      if (value >= 10000) return (value / 10000).toFixed(1).replace(/\.0$/, "") + " " + t("stat.wan");
      return String(value);
    }

    function skillKey(skill) {
      return (skill && (skill.slug || skill.name)) || "";
    }

    // ── Card ─────────────────────────────────────────────────────────

    function SkillCard(_a) {
      var item = _a.item, busy = _a.busy, onDetail = _a.onDetail, onInstall = _a.onInstall, onUninstall = _a.onUninstall;

      var stats = [];
      var downloads = formatCount(item.downloads || item.installs);
      if (downloads) stats.push(t("stat.downloads", { n: downloads }));
      var stars = formatCount(item.stars);
      if (stars) stats.push(t("stat.stars", { n: stars }));
      if (item.version) stats.push("v" + item.version);

      return h("div", { className: "dsh-sh-card" },
        h("div", { className: "dsh-sh-card-head" },
          h("h3", { className: "dsh-sh-card-title", title: item.displayName || item.name || item.slug },
            item.displayName || item.name || item.slug),
          item.installed
            ? h("span", { className: "dsh-sh-badge", "data-tone": "ok" }, t("badge.installed"))
            : null
        ),
        item.summary || item.description
          ? h("p", { className: "dsh-sh-card-desc" }, item.summary || item.description)
          : null,
        stats.length ? h("div", { className: "dsh-sh-card-stats" },
          stats.map(function (s, i) { return h("span", { key: i }, s); }),
          item.source ? h("span", { className: "dsh-sh-badge" }, sourceLabel(item.source)) : null
        ) : null,
        h("div", { className: "dsh-sh-card-actions" },
          h("button", { className: "dsh-sh-btn", type: "button", onClick: function () { onDetail(item); } }, t("btn.detail")),
          item.installed
            ? h("button", {
                className: "dsh-sh-btn", type: "button", "data-kind": "danger", disabled: busy,
                onClick: function () { onUninstall(item); },
              }, busy ? h(Spinner) : t("btn.uninstall"))
            : h("button", {
                className: "dsh-sh-btn", type: "button", "data-kind": "primary", disabled: busy,
                onClick: function () { onInstall(item); },
              }, busy ? h(Spinner) : t("btn.install"))
        )
      );
    }

    // ── Detail ───────────────────────────────────────────────────────

    function DetailView(_a) {
      var detail = _a.detail, loading = _a.loading, busy = _a.busy, onBack = _a.onBack, onInstall = _a.onInstall, onUninstall = _a.onUninstall;

      if (loading) {
        return h("div", { className: "dsh-sh-loading" }, h(Spinner), t("state.loading"));
      }
      if (!detail) {
        return h("div", { className: "dsh-sh-empty" }, t("state.empty"));
      }

      var tags = Array.isArray(detail.tags) ? detail.tags : [];

      return h("div", { className: "dsh-sh-detail" },
        h("div", null,
          h("button", { className: "dsh-sh-btn", type: "button", onClick: onBack }, t("btn.back"))
        ),
        h("div", { className: "dsh-sh-detail-head" },
          h("div", { style: { minWidth: 0, flex: "1 1 260px" } },
            h("h2", { className: "dsh-sh-detail-title" }, detail.displayName || detail.name || detail.slug),
            h("p", { className: "dsh-sh-detail-sub" }, detail.slug || ""),
            detail.summary || detail.description
              ? h("p", { className: "dsh-sh-detail-sub", style: { marginTop: 6 } }, detail.summary || detail.description)
              : null
          ),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flex: "none" } },
            detail.installed
              ? h("button", {
                  className: "dsh-sh-btn", type: "button", "data-kind": "danger", disabled: busy,
                  onClick: function () { onUninstall(detail); },
                }, busy ? h(Spinner) : t("btn.uninstall"))
              : h("button", {
                  className: "dsh-sh-btn", type: "button", "data-kind": "primary", disabled: busy,
                  onClick: function () { onInstall(detail); },
                }, busy ? h(Spinner) : t("btn.install"))
          )
        ),
        h("div", { className: "dsh-sh-detail-meta" },
          detail.source ? h("span", { className: "dsh-sh-badge" }, sourceLabel(detail.source)) : null,
          detail.version ? h("span", null, t("meta.version", { v: detail.version })) : null,
          formatCount(detail.downloads || detail.installs) ? h("span", null, t("stat.downloads", { n: formatCount(detail.downloads || detail.installs) })) : null,
          formatCount(detail.stars) ? h("span", null, t("stat.stars", { n: formatCount(detail.stars) })) : null,
          detail.author ? h("span", null, t("meta.author", { a: detail.author })) : null,
          detail.installed ? h("span", { className: "dsh-sh-badge", "data-tone": "ok" }, t("badge.installed")) : null
        ),
        tags.length
          ? h("div", { className: "dsh-sh-detail-tags" },
              tags.map(function (tag, i) { return h("span", { key: i, className: "dsh-sh-badge", "data-tone": "brand" }, String(tag)); }))
          : null,
        h("div", null,
          h("h3", { className: "dsh-sh-section-title" }, t("section.readme")),
          detail.readme
            ? h("div", { className: "dsh-sh-md", dangerouslySetInnerHTML: { __html: renderMarkdown(detail.readme) } })
            : h("div", { className: "dsh-sh-empty" }, t("state.noReadme"))
        )
      );
    }

    // ── Page (the `main` seat) ───────────────────────────────────────

    function SkillHubPage(props) {
      var rpc = props.rpc;
      var apiRef = useRef(null);
      if (!apiRef.current) apiRef.current = makeApi(rpc);
      var api = apiRef.current;

      var _tab = useState("market"), tab = _tab[0], setTab = _tab[1];
      var _kw = useState(""), keyword = _kw[0], setKeyword = _kw[1];
      var _src = useState(""), source = _src[0], setSource = _src[1];
      var _cat = useState(""), category = _cat[0], setCategory = _cat[1];

      var _items = useState([]), items = _items[0], setItems = _items[1];
      var _loading = useState(false), loading = _loading[0], setLoading = _loading[1];
      var _error = useState(""), error = _error[0], setError = _error[1];

      var _cats = useState([]), categories = _cats[0], setCategories = _cats[1];

      var _installed = useState([]), installed = _installed[0], setInstalled = _installed[1];
      var _installedLoading = useState(false), installedLoading = _installedLoading[0], setInstalledLoading = _installedLoading[1];

      var _detail = useState(null), detail = _detail[0], setDetail = _detail[1];
      var _detailLoading = useState(false), detailLoading = _detailLoading[0], setDetailLoading = _detailLoading[1];

      var _busy = useState({}), busy = _busy[0], setBusy = _busy[1];
      var _toast = useState(null), toast = _toast[0], setToast = _toast[1];

      var toastTimer = useRef(0);
      var showToast = function (message, tone) {
        setToast({ message: message, tone: tone || "info" });
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(function () { setToast(null); }, 2600);
      };
      useEffect(function () {
        return function () { if (toastTimer.current) window.clearTimeout(toastTimer.current); };
      }, []);

      var markBusy = function (key, value) {
        setBusy(function (prev) {
          var next = Object.assign({}, prev);
          if (value) next[key] = true;
          else delete next[key];
          return next;
        });
      };

      var applyInstalledFlags = function (list, installedNames) {
        var names = installedNames || {};
        return list.map(function (item) {
          var key = skillKey(item);
          return Object.assign({}, item, { installed: !!names[String(key).toLowerCase()] || !!item.installed });
        });
      };

      var loadInstalled = function () {
        setInstalledLoading(true);
        return api.call("skill-hub/installed", {})
          .then(function (value) {
            var list = (value && value.skills) || [];
            setInstalled(list);
            var names = {};
            list.forEach(function (s) { names[String(skillKey(s)).toLowerCase()] = true; });
            setItems(function (prev) { return applyInstalledFlags(prev, names); });
            return names;
          })
          .catch(function (e) { setError(e.message || String(e)); return null; })
          .then(function (names) { setInstalledLoading(false); return names; });
      };

      var search = function (next) {
        var q = next || {};
        var kw = q.keyword !== undefined ? q.keyword : keyword;
        var src = q.source !== undefined ? q.source : source;
        var cat = q.category !== undefined ? q.category : category;

        setLoading(true);
        setError("");
        var payload = { keyword: kw, page: 1, pageSize: 60 };
        if (src) payload.source = src;
        if (cat) payload.category = cat;

        api.call("skill-hub/search", payload)
          .then(function (value) {
            var list = (value && value.items) || [];
            setItems(list);
            var failed = (value && value.errors) || [];
            if (!list.length && failed.length) {
              setError(failed.map(function (f) { return f.source + ": " + f.error; }).join("；"));
            }
            loadInstalled();
          })
          .catch(function (e) { setError(e.message || String(e)); setItems([]); })
          .then(function () { setLoading(false); });
      };

      // Initial load: categories + first page + installed list.
      useEffect(function () {
        var cancelled = false;
        api.call("skill-hub/categories", {})
          .then(function (value) {
            if (cancelled) return;
            var list = (value && value.categories) || [];
            setCategories(Array.isArray(list) ? list : []);
          })
          .catch(function () { /* categories are optional */ });
        search({ keyword: "", category: "" });
        return function () { cancelled = true; };
      }, []);

      var refreshInstalledTab = function () {
        if (tab === "installed") loadInstalled();
      };
      useEffect(function () {
        if (tab === "installed") loadInstalled();
      }, [tab]);

      var openDetail = function (skill) {
        setDetailLoading(true);
        setDetail(null);
        var payload = { slug: skill.slug || skill.name };
        if (skill.source) payload.source = skill.source;
        if (skill.ownerHandle) payload.ownerHandle = skill.ownerHandle;
        api.call("skill-hub/detail", payload)
          .then(function (value) { setDetail(value || null); })
          .catch(function (e) { showToast(t("err.detail", { e: e.message || e }), "error"); })
          .then(function () { setDetailLoading(false); });
      };

      var doInstall = function (skill) {
        var key = skillKey(skill);
        markBusy(key, true);
        var payload = { slug: key };
        if (skill.source) payload.source = skill.source;
        if (skill.ownerHandle) payload.ownerHandle = skill.ownerHandle;
        api.call("skill-hub/install", payload)
          .then(function () {
            showToast(t("toast.installed", { name: key }), "success");
            setItems(function (prev) {
              return prev.map(function (it) {
                return skillKey(it) === key ? Object.assign({}, it, { installed: true }) : it;
              });
            });
            if (detail && skillKey(detail) === key) setDetail(Object.assign({}, detail, { installed: true }));
            loadInstalled();
          })
          .catch(function (e) { showToast(t("err.install", { e: e.message || e }), "error"); })
          .then(function () { markBusy(key, false); });
      };

      var doUninstall = function (skill) {
        var key = skillKey(skill);
        if (!window.confirm(t("confirm.uninstall", { name: skill.displayName || skill.name || key }))) return;
        markBusy(key, true);
        api.call("skill-hub/uninstall", { slug: key })
          .then(function () {
            showToast(t("toast.uninstalled", { name: key }), "success");
            setItems(function (prev) {
              return prev.map(function (it) {
                return skillKey(it) === key ? Object.assign({}, it, { installed: false }) : it;
              });
            });
            if (detail && skillKey(detail) === key) setDetail(Object.assign({}, detail, { installed: false }));
            loadInstalled();
          })
          .catch(function (e) { showToast(t("err.uninstall", { e: e.message || e }), "error"); })
          .then(function () { markBusy(key, false); });
      };

      var renderMarket = function () {
        if (loading && !items.length) return h("div", { className: "dsh-sh-loading" }, h(Spinner), t("state.searching"));
        if (!items.length) {
          return h("div", { className: "dsh-sh-empty" }, t("state.noResults"));
        }
        return h("div", { className: "dsh-sh-grid" },
          items.map(function (item) {
            var key = skillKey(item);
            return h(SkillCard, {
              key: item.source + ":" + key,
              item: item,
              busy: !!busy[key],
              onDetail: openDetail,
              onInstall: doInstall,
              onUninstall: doUninstall,
            });
          })
        );
      };

      var renderInstalled = function () {
        if (installedLoading && !installed.length) return h("div", { className: "dsh-sh-loading" }, h(Spinner), t("state.loading"));
        if (!installed.length) return h("div", { className: "dsh-sh-empty" }, t("state.noInstalled"));
        return h("div", { className: "dsh-sh-list" },
          installed.map(function (skill) {
            var key = skillKey(skill);
            return h("div", { className: "dsh-sh-row", key: key },
              h("div", { className: "dsh-sh-row-main" },
                h("span", { className: "dsh-sh-row-title" }, skill.displayName || skill.name || key),
                h("span", { className: "dsh-sh-row-sub" }, skill.summary || skill.description || "—")
              ),
              skill.sourceLabel ? h("span", { className: "dsh-sh-badge" }, skill.sourceLabel) : null,
              skill.version ? h("span", { className: "dsh-sh-badge" }, "v" + skill.version) : null,
              h("button", { className: "dsh-sh-btn", type: "button", onClick: function () { openDetail(skill); } }, t("btn.detail")),
              h("button", {
                className: "dsh-sh-btn", type: "button", "data-kind": "danger", disabled: !!busy[key],
                onClick: function () { doUninstall(skill); },
              }, busy[key] ? h(Spinner) : t("btn.uninstall"))
            );
          })
        );
      };

      var body;
      if (detail || detailLoading) {
        body = h(DetailView, {
          detail: detail, loading: detailLoading, busy: detail ? !!busy[skillKey(detail)] : false,
          onBack: function () { setDetail(null); setDetailLoading(false); },
          onInstall: doInstall, onUninstall: doUninstall,
        });
      } else if (tab === "installed") {
        body = renderInstalled();
      } else {
        body = renderMarket();
      }

      return h("div", { className: "dsh-sh-root", "data-dsh-skill-hub-page": "" },
        h(Styles),
        h("div", { className: "dsh-sh-head" },
          h("h1", { className: "dsh-sh-title" }, t("page.title")),
          h("div", { className: "dsh-sh-search" },
            h("input", {
              value: keyword,
              placeholder: t("page.searchPlaceholder"),
              onChange: function (e) { setKeyword(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") search({ keyword: e.target.value }); },
            })
          ),
          h("select", {
            className: "dsh-sh-src", value: source,
            onChange: function (e) { setSource(e.target.value); search({ source: e.target.value }); },
            title: t("page.sourceTitle"),
          },
            h("option", { value: "" }, t("src.all")),
            h("option", { value: "skillhub" }, "SkillHub"),
            h("option", { value: "clawhub" }, "ClawHub")
          )
        ),
        h("div", { className: "dsh-sh-tabs" },
          h("button", {
            className: "dsh-sh-tab", type: "button", "data-active": tab === "market" ? "" : undefined,
            onClick: function () { setTab("market"); setDetail(null); },
          }, t("tab.market")),
          h("button", {
            className: "dsh-sh-tab", type: "button", "data-active": tab === "installed" ? "" : undefined,
            onClick: function () { setTab("installed"); setDetail(null); },
          }, t("tab.installed"))
        ),
        h("div", { className: "dsh-sh-body" },
          tab === "market" && !detail && !detailLoading && categories.length
            ? h("div", { className: "dsh-sh-rail" },
                h("button", {
                  type: "button", "data-active": category === "" ? "" : undefined,
                  onClick: function () { setCategory(""); search({ category: "" }); },
                }, t("cat.all")),
                categories.map(function (cat, i) {
                  var id = cat.id || cat.slug || cat.key || cat.name || String(i);
                  var name = cat.name || cat.displayName || cat.label || id;
                  return h("button", {
                    key: id, type: "button", title: name,
                    "data-active": category === id ? "" : undefined,
                    onClick: function () { setCategory(id); search({ category: id }); },
                  }, name);
                })
              )
            : null,
          h("div", { className: "dsh-sh-content" },
            error ? h("div", { className: "dsh-sh-error" }, error) : null,
            body
          )
        ),
        toast ? h(Toast, { message: toast.message, tone: toast.tone }) : null
      );
    }

    // ── Sidebar row glyph (the `sidebar.panellist` seat) ─────────────

    function SkillHubIcon(props) {
      var size = (props && typeof props.size === "number" && props.size > 0) ? props.size : 16;
      return h("svg", {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.4",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
        style: { display: "block" },
      }, h("path", { d: "M9.2 1.6 3.4 9h4l-1.1 5.4L12.6 7h-4l.6-5.4Z" }));
    }

    // ── Composer picker (the `conversation.input.left` seat) ─────────

    function ChatInputButton(props) {
      var rpc = props.rpc;
      var inputActions = props.inputActions;
      var apiRef = useRef(null);
      if (!apiRef.current) apiRef.current = makeApi(rpc);

      var _open = useState(false), open = _open[0], setOpen = _open[1];
      var _list = useState([]), list = _list[0], setList = _list[1];
      var _loading = useState(false), loading = _loading[0], setLoading = _loading[1];
      var _kw = useState(""), keyword = _kw[0], setKeyword = _kw[1];
      var wrapRef = useRef(null);

      var load = function () {
        setLoading(true);
        apiRef.current.call("skill-hub/installed", {})
          .then(function (value) { setList((value && value.skills) || []); })
          .catch(function () { setList([]); })
          .then(function () { setLoading(false); });
      };

      var toggle = function () {
        if (!open) load();
        setOpen(!open);
      };

      useEffect(function () {
        if (!open) return;
        var onDown = function (e) {
          if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        var onKey = function (e) { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return function () {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      var pick = function (skill) {
        var name = skill.slug || skill.name;
        if (inputActions && typeof inputActions.setDraft === "function") {
          inputActions.setDraft("/" + name + " ");
        } else {
          window.dispatchEvent(new CustomEvent("dsh-skill-hub-insert", { detail: { skill: name } }));
        }
        setOpen(false);
        setKeyword("");
      };

      var slugOf = function (s) { return (s && (s.slug || s.name)) || ""; };

      var q = keyword.trim().toLowerCase();
      var filtered = q
        ? list.filter(function (s) {
            return String(slugOf(s)).toLowerCase().indexOf(q) >= 0 ||
              String(s.displayName || s.name || "").toLowerCase().indexOf(q) >= 0;
          })
        : list;

      return h("div", { className: "dsh-sh-picker-wrap", ref: wrapRef },
        h(Styles),
        h("button", {
          className: "dsh-sh-btn", type: "button", onClick: toggle, title: t("picker.title"),
          "aria-expanded": open ? "true" : "false",
        }, h(SkillHubIcon, { size: 13 }), t("picker.button")),
        open
          ? h("div", { className: "dsh-sh-picker" },
              h("div", { className: "dsh-sh-picker-head" },
                h("input", {
                  autoFocus: true, value: keyword, placeholder: t("picker.filter"),
                  onChange: function (e) { setKeyword(e.target.value); },
                })
              ),
              h("div", { className: "dsh-sh-picker-list" },
                loading
                  ? h("div", { className: "dsh-sh-loading" }, h(Spinner), t("state.loading"))
                  : !filtered.length
                    ? h("div", { className: "dsh-sh-empty" }, list.length ? t("picker.noMatch") : t("picker.empty"))
                    : filtered.map(function (skill) {
                        var key = slugOf(skill);
                        return h("button", {
                          key: key, className: "dsh-sh-picker-item", type: "button",
                          onClick: function () { pick(skill); },
                        },
                          h("span", { className: "dsh-sh-picker-name" }, skill.displayName || skill.name || key),
                          h("span", { className: "dsh-sh-picker-desc" }, skill.summary || skill.description || key)
                        );
                      })
              )
            )
          : null
      );
    }

    // ── Entry ────────────────────────────────────────────────────────

    var inject = ["slots", "connection"];

    function apply(ctx) {
      var rpc = ctx.get("connection").rpc;

      // Visible text goes through the host's locale service. `ctx.locale` is
      // only reachable through `ctx.get`, and the service is optional, so the
      // built-in table above keeps working if it is absent.
      ctx.effect(function () {
        try {
          var locale = typeof ctx.get === "function" ? ctx.get("locale") : undefined;
          if (locale && typeof locale.register === "function") {
            locale.register(NS, DICT);
            if (typeof locale.bind === "function") {
              var bound = locale.bind(NS);
              if (typeof bound === "function") t = bound;
            }
          }
        } catch (e) { /* no locale service: keep the built-in table */ }
        return function () {};
      }, "dsh-skill-hub: locale");

      // The sidebar row. The shell draws it: geometry, indent, label colour,
      // hover, collapsed rail, active highlight and the panel switch.
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register({
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function () { return t("page.title"); },
          }, SkillHubIcon);
        });
      }, "dsh-skill-hub: sidebar row");

      // The centre-column page that row switches to.
      ctx.effect(function () {
        return ctx.slots.inject("main", function () {
          return ctx.slots.register({
            name: "main",
            key: PANEL_ID,
            inject: function () { return { rpc: rpc }; },
          }, SkillHubPage);
        });
      }, "dsh-skill-hub: main page");

      // Convenience picker next to the composer.
      ctx.effect(function () {
        return ctx.slots.inject("conversation.input.left", function () {
          return ctx.slots.register({
            name: "conversation.input.left",
            id: PANEL_ID,
            order: INPUT_ORDER,
            inject: function () { return { rpc: rpc }; },
          }, ChatInputButton);
        });
      }, "dsh-skill-hub: composer picker");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
