/**
 * dsh-skill-hub — browser half.
 *
 * Contributes three things through the host's public slot contracts:
 *   sidebar.panellist        one row in the shell's own panel list
 *   main                     the centre-column page that row switches to
 *   conversation.input.left  a chip beside the composer that inserts /<skill>
 *
 * It never touches the DOM outside its own components, never reads another
 * plugin's markup, and styles itself exclusively with --dsw-alias-* tokens so
 * it follows whatever theme is active.
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
    var useCallback = React.useCallback;
    var useMemo = React.useMemo;

    // ── locale ────────────────────────────────────────────────────────────

    var NS = "dsh-skill-hub";

    var DICT = {
      zh: {
        "panel.title": "技能·专家",
        "tab.market": "技能",
        "tab.experts": "专家",
        "tab.installed": "已安装",
        "experts.placeholder": "搜索专家…",
        "experts.dept.all": "全部部门",
        "experts.count": "{n} 位专家",
        "experts.empty": "专家名单暂时不可用",
        "experts.noMatch": "没有匹配的专家",
        "experts.hint": "选一位专家，安装后即可在对话中调用它的人格与专长",
        "experts.installed": "已加入",
        "search.placeholder": "搜索技能…",
        "search.clear": "清除",
        "source.all": "全部来源",
        "category.all": "全部",
        "action.install": "安装",
        "action.installing": "安装中…",
        "action.installed": "已安装",
        "action.uninstall": "卸载",
        "action.use": "使用",
        "action.detail": "详情",
        "action.back": "返回",
        "action.retry": "重试",
        "action.loadMore": "加载更多",
        "empty.market": "没有匹配的技能",
        "empty.hint": "换个关键词，或切换来源试试",
        "empty.installed": "还没有安装任何技能",
        "loading": "加载中…",
        "error.generic": "出错了",
        "error.partial": "部分来源不可用",
        "installed.dir": "技能目录",
        "detail.version": "版本",
        "detail.author": "作者",
        "detail.downloads": "下载",
        "detail.stars": "收藏",
        "detail.category": "分类",
        "detail.license": "许可",
        "detail.source": "来源",
        "detail.readme": "说明",
        "detail.readmeEmpty": "该技能没有提供说明文档",
        "toast.installed": "已安装「{name}」",
        "toast.uninstalled": "已卸载「{name}」",
        "toast.failed": "操作失败：{message}",
        "composer.button": "技能·专家",
        "composer.hint": "技能·专家",
        "composer.browseSkills": "浏览技能",
        "composer.browseExperts": "浏览专家"
      },
      en: {
        "panel.title": "SkillAgency",
        "tab.market": "Skills",
        "tab.experts": "Experts",
        "tab.installed": "Installed",
        "experts.placeholder": "Search experts…",
        "experts.dept.all": "All departments",
        "experts.count": "{n} experts",
        "experts.empty": "The roster is unavailable right now",
        "experts.noMatch": "No matching experts",
        "experts.hint": "Pick an expert and install it to bring its persona and craft into the chat",
        "experts.installed": "Added",
        "search.placeholder": "Search skills…",
        "search.clear": "Clear",
        "source.all": "All sources",
        "category.all": "All",
        "action.install": "Install",
        "action.installing": "Installing…",
        "action.installed": "Installed",
        "action.uninstall": "Uninstall",
        "action.use": "Use",
        "action.detail": "Details",
        "action.back": "Back",
        "action.retry": "Retry",
        "action.loadMore": "Load more",
        "empty.market": "No matching skills",
        "empty.hint": "Try another keyword or a different source",
        "empty.installed": "No skills installed yet",
        "loading": "Loading…",
        "error.generic": "Something went wrong",
        "error.partial": "Some sources are unavailable",
        "installed.dir": "Skills directory",
        "detail.version": "Version",
        "detail.author": "Author",
        "detail.downloads": "Downloads",
        "detail.stars": "Stars",
        "detail.category": "Category",
        "detail.license": "License",
        "detail.source": "Source",
        "detail.readme": "Readme",
        "detail.readmeEmpty": "This skill ships no readme",
        "toast.installed": "Installed “{name}”",
        "toast.uninstalled": "Uninstalled “{name}”",
        "toast.failed": "Action failed: {message}",
        "composer.button": "SkillAgency",
        "composer.hint": "SkillAgency",
        "composer.browseSkills": "Browse skills",
        "composer.browseExperts": "Browse experts"
      }
    };

    function detectLocale() {
      try {
        var lang = document.documentElement && document.documentElement.lang;
        if (lang && /^en(?:-|$)/i.test(lang)) return "en";
      } catch (e) {
        /* ignore */
      }
      return "zh";
    }

    var activeLocale = detectLocale();

    function translate(key, params) {
      var table = DICT[activeLocale] || DICT.zh;
      var text = table[key] || DICT.en[key] || key;
      if (params) {
        Object.keys(params).forEach(function (name) {
          text = String(text).replace("{" + name + "}", params[name]);
        });
      }
      return text;
    }

    var t = translate;

    /** Bind the host locale service when it is reachable; keep the local guess otherwise. */
    function bindLocale(ctx) {
      try {
        var locale = (typeof ctx.get === "function" ? ctx.get("locale") : undefined) || ctx.locale;
        if (!locale || typeof locale.register !== "function") return;
        try {
          locale.register(NS, DICT);
        } catch (e) {
          /* registering twice throws; the first registration wins */
        }
        if (typeof locale.bind === "function") {
          var bound = locale.bind(NS);
          if (typeof bound === "function") t = bound;
        }
      } catch (e) {
        /* no locale service — fall back to the document language */
      }
    }

    // ── styles ────────────────────────────────────────────────────────────

    var CSS = [
      ".dsh-sh-page{display:flex;flex-direction:column;height:100%;min-height:0;width:100%;min-width:0;",
      "background:var(--dsw-alias-bg-base,#1a1a2e);color:var(--dsw-alias-label-primary,#e0e0e0);",
      "font-size:14px;line-height:1.45;box-sizing:border-box}",

      ".dsh-sh-top{flex:none;display:flex;flex-direction:column;gap:10px;padding:14px 18px 10px;",
      "border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",

      ".dsh-sh-title-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".dsh-sh-heading{margin:0;font-size:16px;font-weight:600;letter-spacing:.2px}",

      ".dsh-sh-tabs{display:inline-flex;gap:2px;padding:2px;margin-left:auto;",
      "background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.05));",
      "border:1px solid var(--dsw-alias-border-l1,transparent);border-radius:10px}",
      ".dsh-sh-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#a0a0a0);",
      "font:inherit;font-size:13px;padding:4px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}",
      ".dsh-sh-tab:hover{color:var(--dsw-alias-label-primary,#fff)}",
      ".dsh-sh-tab[data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));",
      "color:var(--dsw-alias-label-primary,#fff);font-weight:600}",

      ".dsh-sh-search-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dsh-sh-search{position:relative;flex:1;min-width:180px;display:flex;align-items:center}",
      ".dsh-sh-search-input{width:100%;box-sizing:border-box;padding:8px 30px 8px 12px;font:inherit;font-size:13px;",
      "color:var(--dsw-alias-label-primary,#e0e0e0);",
      "background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.2));",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:9px;outline:none}",
      ".dsh-sh-search-input:focus{border-color:var(--dsw-alias-brand-primary,#6366f1)}",
      ".dsh-sh-search-input::placeholder{color:var(--dsw-alias-label-tertiary,#808080)}",
      ".dsh-sh-search-clear{position:absolute;right:6px;appearance:none;border:none;background:transparent;",
      "color:var(--dsw-alias-label-tertiary,#808080);cursor:pointer;font-size:15px;line-height:1;padding:4px}",
      ".dsh-sh-search-clear:hover{color:var(--dsw-alias-label-primary,#fff)}",

      ".dsh-sh-sources{display:inline-flex;gap:6px;flex-wrap:wrap}",
      ".dsh-sh-chip{appearance:none;font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer;",
      "color:var(--dsw-alias-label-secondary,#a0a0a0);",
      "background:transparent;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14))}",
      ".dsh-sh-chip:hover{color:var(--dsw-alias-label-primary,#fff);",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".dsh-sh-chip[data-active]{color:var(--dsw-alias-label-primary,#fff);font-weight:600;",
      "border-color:var(--dsw-alias-brand-primary,#6366f1);",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}",

      ".dsh-sh-body{flex:1;display:flex;min-height:0;overflow:hidden}",

      ".dsh-sh-cats{width:150px;flex:none;overflow-y:auto;padding:10px 8px;",
      "border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
      ".dsh-sh-cat{display:block;width:100%;box-sizing:border-box;appearance:none;border:none;background:transparent;",
      "font:inherit;font-size:13px;text-align:left;color:var(--dsw-alias-label-secondary,#a0a0a0);",
      "padding:6px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-sh-cat:hover{color:var(--dsw-alias-label-primary,#fff);",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".dsh-sh-cat[data-active]{color:var(--dsw-alias-label-primary,#fff);font-weight:600;",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}",

      ".dsh-sh-main{flex:1;min-width:0;overflow-y:auto;padding:12px 14px 24px}",

      ".dsh-sh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}",
      ".dsh-sh-card{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;",
      "background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.04));",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));cursor:pointer;",
      "transition:border-color .12s ease,background .12s ease}",
      ".dsh-sh-card:hover{border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.2));",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}",
      ".dsh-sh-card-head{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dsh-sh-avatar{width:26px;height:26px;flex:none;border-radius:7px;object-fit:cover;",
      "background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}",
      ".dsh-sh-avatar-fallback{width:26px;height:26px;flex:none;border-radius:7px;display:flex;",
      "align-items:center;justify-content:center;font-size:12px;font-weight:600;",
      "background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));",
      "color:var(--dsw-alias-label-secondary,#a0a0a0)}",
      ".dsh-sh-card-title{font-size:13px;font-weight:600;min-width:0;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap;flex:1}",
      ".dsh-sh-badge{flex:none;font-size:11px;padding:1px 7px;border-radius:999px;",
      "color:var(--dsw-alias-label-secondary,#a0a0a0);",
      "background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07))}",
      ".dsh-sh-badge[data-tone=installed]{color:var(--dsw-alias-state-success-primary,#8ec07c)}",
      ".dsh-sh-badge[data-tone=verified]{color:var(--dsw-alias-brand-primary,#6366f1)}",
      ".dsh-sh-card-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#a0a0a0);",
      "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.9em}",
      ".dsh-sh-card-foot{display:flex;align-items:center;gap:8px;font-size:11px;",
      "color:var(--dsw-alias-label-tertiary,#808080);margin-top:auto}",
      ".dsh-sh-card-actions{display:flex;gap:6px;margin-left:auto}",

      ".dsh-sh-btn{appearance:none;font:inherit;font-size:12px;padding:4px 11px;border-radius:7px;cursor:pointer;",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));",
      "background:var(--dsw-alias-button-elevated-fill,rgba(255,255,255,.07));",
      "color:var(--dsw-alias-label-primary,#e0e0e0);white-space:nowrap}",
      ".dsh-sh-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12))}",
      ".dsh-sh-btn[disabled]{opacity:.55;cursor:default}",
      ".dsh-sh-btn[data-variant=primary]{border-color:transparent;font-weight:600;",
      "background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#6366f1));",
      "color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".dsh-sh-btn[data-variant=danger]{color:var(--dsw-alias-state-error-primary,#FC7B6B)}",

      ".dsh-sh-list{display:flex;flex-direction:column;gap:8px}",
      ".dsh-sh-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;",
      "background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.04));",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
      ".dsh-sh-row-body{min-width:0;flex:1}",
      ".dsh-sh-row-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sh-row-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#a0a0a0);",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-sh-row[data-clickable]{cursor:pointer}",
      ".dsh-sh-row[data-clickable]:hover{border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.2))}",
      ".dsh-sh-expert-emoji{flex:none;width:26px;text-align:center;font-size:17px;line-height:1}",
      ".dsh-sh-group-title{font-size:12px;font-weight:600;letter-spacing:.4px;margin:16px 0 2px;",
      "color:var(--dsw-alias-label-secondary,#a0a0a0)}",
      ".dsh-sh-group-title:first-child{margin-top:0}",
      ".dsh-sh-expert-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#a0a0a0)}",

      ".dsh-sh-detail{display:flex;flex-direction:column;gap:14px;max-width:860px}",
      ".dsh-sh-detail-head{display:flex;align-items:flex-start;gap:10px}",
      ".dsh-sh-detail-title{margin:0;font-size:17px;font-weight:600}",
      ".dsh-sh-detail-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#a0a0a0);margin-top:3px}",
      ".dsh-sh-meta{display:flex;flex-wrap:wrap;gap:8px 18px;padding:10px 12px;border-radius:10px;font-size:12px;",
      "background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.04));",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
      ".dsh-sh-meta-item{display:flex;gap:6px;align-items:baseline}",
      ".dsh-sh-meta-key{color:var(--dsw-alias-label-tertiary,#808080)}",
      ".dsh-sh-meta-value{color:var(--dsw-alias-label-primary,#e0e0e0)}",
      ".dsh-sh-section-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;",
      "color:var(--dsw-alias-label-tertiary,#808080);margin-bottom:6px}",
      ".dsh-sh-md{font-size:13px;line-height:1.65;word-break:break-word}",
      ".dsh-sh-md h1,.dsh-sh-md h2,.dsh-sh-md h3{margin:14px 0 6px;line-height:1.3}",
      ".dsh-sh-md h1{font-size:17px}.dsh-sh-md h2{font-size:15px}.dsh-sh-md h3{font-size:14px}",
      ".dsh-sh-md p{margin:6px 0}",
      ".dsh-sh-md ul,.dsh-sh-md ol{margin:6px 0;padding-left:20px}",
      ".dsh-sh-md li{margin:2px 0}",
      ".dsh-sh-md code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;padding:1px 5px;",
      "border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}",
      ".dsh-sh-md pre{padding:10px 12px;border-radius:9px;overflow-x:auto;margin:8px 0;",
      "background:var(--dsw-alias-markdown-code-block,rgba(0,0,0,.28))}",
      ".dsh-sh-md pre code{padding:0;background:transparent}",
      ".dsh-sh-md a{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary,#8ec07c))}",
      ".dsh-sh-md blockquote{margin:8px 0;padding-left:10px;",
      "border-left:3px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));",
      "color:var(--dsw-alias-label-secondary,#a0a0a0)}",
      ".dsh-sh-md table{border-collapse:collapse;margin:8px 0;font-size:12px}",
      ".dsh-sh-md th,.dsh-sh-md td{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));",
      "padding:4px 8px;text-align:left}",
      ".dsh-sh-md hr{border:none;height:1px;margin:12px 0;background:var(--dsw-alias-border-l1,rgba(255,255,255,.12))}",

      ".dsh-sh-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;",
      "padding:48px 16px;color:var(--dsw-alias-label-tertiary,#808080);font-size:13px;text-align:center}",
      ".dsh-sh-error{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:9px;font-size:12px;",
      "margin-bottom:10px;color:var(--dsw-alias-state-warn-primary,#fabd2f);",
      "background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.05));",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",

      ".dsh-sh-spinner{width:16px;height:16px;border-radius:50%;",
      "border:2px solid var(--dsw-alias-border-l1,rgba(255,255,255,.18));",
      "border-top-color:var(--dsw-alias-brand-primary,#6366f1);animation:dsh-sh-spin .7s linear infinite}",
      "@keyframes dsh-sh-spin{to{transform:rotate(360deg)}}",

      ".dsh-sh-toast{position:absolute;left:50%;transform:translateX(-50%);bottom:18px;z-index:20;",
      "padding:8px 16px;border-radius:9px;font-size:13px;max-width:80%;",
      "background:var(--dsw-alias-toast-bg,rgba(20,20,20,.94));",
      "color:var(--dsw-alias-toast-label,var(--dsw-alias-label-primary,#fff));",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));",
      "box-shadow:0 8px 24px rgba(0,0,0,.28)}",
      ".dsh-sh-toast[data-tone=error]{color:var(--dsw-alias-state-error-primary,#FC7B6B)}",

      // composer chip
      ".dsh-sh-composer-btn{appearance:none;font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;",
      "cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary,#a0a0a0);",
      "background:transparent;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14))}",
      ".dsh-sh-composer-btn:hover{color:var(--dsw-alias-label-primary,#fff);",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dsh-sh-composer-btn.dsh-sh-composer-icon{padding:4px;width:26px;height:26px;",
      "display:inline-flex;align-items:center;justify-content:center;border-radius:7px}",
      ".dsh-sh-picker{position:absolute;bottom:100%;left:0;margin-bottom:6px;width:280px;max-height:300px;",
      "overflow-y:auto;z-index:30;padding:6px;border-radius:11px;",
      "background:var(--dsw-alias-bg-module-platform,rgba(40,40,40,.98));",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));",
      "box-shadow:0 14px 36px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#e0e0e0)}",
      ".dsh-sh-picker-item{display:block;width:100%;box-sizing:border-box;text-align:left;font:inherit;font-size:13px;",
      "padding:7px 10px;border-radius:7px;cursor:pointer;border:none;background:transparent;",
      "color:var(--dsw-alias-label-primary,#e0e0e0)}",
      ".dsh-sh-picker-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}",
      ".dsh-sh-picker-empty{padding:10px;font-size:12px;",
      "color:var(--dsw-alias-label-tertiary,#808080);text-align:center}",
      ".dsh-sh-picker-tabs{display:flex;gap:4px;padding:2px 2px 6px}",
      ".dsh-sh-picker-tab{appearance:none;font:inherit;font-size:12px;padding:5px 9px;border-radius:7px;",
      "cursor:pointer;flex:1;color:var(--dsw-alias-label-secondary,#a0a0a0);background:transparent;",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14))}",
      ".dsh-sh-picker-tab:hover{color:var(--dsw-alias-label-primary,#fff);",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dsh-sh-picker-tab[data-active]{color:var(--dsw-alias-label-primary,#fff);font-weight:600;",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}",
      ".dsh-sh-picker-search{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:12px;",
      "padding:5px 8px;margin-bottom:4px;border-radius:7px;outline:none;",
      "color:var(--dsw-alias-label-primary,#e0e0e0);background:var(--dsw-alias-bg-base,rgba(0,0,0,.2));",
      "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14))}",

      "@media (max-width:720px){.dsh-sh-cats{display:none}}"
    ].join("");

    function Styles() {
      return h("style", { "data-dsh-skill-hub": "" }, CSS);
    }

    // ── markdown ──────────────────────────────────────────────────────────

    function escapeHtml(text) {
      return String(text == null ? "" : text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    /**
     * Allow only URLs that cannot execute script. A skill readme is remote
     * content, so `javascript:` / `data:` and protocol-relative targets are
     * dropped rather than rendered as links.
     */
    function safeUrl(raw) {
      var value = String(raw == null ? "" : raw)
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim();
      if (!value) return "";
      if (value.startsWith("#")) return value;
      if (/^https?:\/\//i.test(value)) return value;
      if (/^mailto:/i.test(value)) return value;
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
      if (value.startsWith("//")) return "";
      return value;
    }

    function renderInline(text) {
      var out = String(text);
      out = out.replace(/`([^`]+)`/g, function (_, code) {
        return "<code>" + code + "</code>";
      });
      out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, function (whole, label, href) {
        var target = safeUrl(href);
        if (!target) return label;
        return '<a href="' + target + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
      });
      out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
      return out;
    }

    /**
     * A deliberately small markdown subset: headings, lists, quotes, fences,
     * tables and paragraphs. Everything is escaped first, so no raw HTML from a
     * remote readme can reach the DOM.
     */
    function renderMarkdown(markdown) {
      var source = String(markdown || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      // Drop a leading frontmatter block; it is metadata, not prose.
      if (source.startsWith("---")) {
        var close = source.indexOf("\n---", 3);
        if (close >= 0) source = source.slice(source.indexOf("\n", close + 1) + 1);
      }

      var lines = escapeHtml(source).split("\n");
      var html = [];
      var listMode = "";
      var inFence = false;
      var fenceLines = [];
      var paragraph = [];

      function flushParagraph() {
        if (!paragraph.length) return;
        html.push("<p>" + renderInline(paragraph.join(" ")) + "</p>");
        paragraph = [];
      }

      function closeList() {
        if (!listMode) return;
        html.push("</" + listMode + ">");
        listMode = "";
      }

      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];

        if (/^\s*```/.test(line)) {
          if (inFence) {
            html.push("<pre><code>" + fenceLines.join("\n") + "</code></pre>");
            fenceLines = [];
            inFence = false;
          } else {
            flushParagraph();
            closeList();
            inFence = true;
          }
          continue;
        }

        if (inFence) {
          fenceLines.push(line);
          continue;
        }

        if (!line.trim()) {
          flushParagraph();
          closeList();
          continue;
        }

        var heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
          flushParagraph();
          closeList();
          var level = heading[1].length;
          html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
          continue;
        }

        if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
          flushParagraph();
          closeList();
          html.push("<hr>");
          continue;
        }

        var quote = /^\s*&gt;\s?(.*)$/.exec(line);
        if (quote) {
          flushParagraph();
          closeList();
          html.push("<blockquote>" + renderInline(quote[1]) + "</blockquote>");
          continue;
        }

        var bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
          flushParagraph();
          if (listMode !== "ul") {
            closeList();
            listMode = "ul";
            html.push("<ul>");
          }
          html.push("<li>" + renderInline(bullet[1]) + "</li>");
          continue;
        }

        var ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (ordered) {
          flushParagraph();
          if (listMode !== "ol") {
            closeList();
            listMode = "ol";
            html.push("<ol>");
          }
          html.push("<li>" + renderInline(ordered[1]) + "</li>");
          continue;
        }

        if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
          flushParagraph();
          closeList();
          var headers = line.split("|").map(function (cell) {
            return cell.trim();
          });
          if (headers[0] === "") headers.shift();
          if (headers[headers.length - 1] === "") headers.pop();

          var rows = [];
          var cursor = i + 2;
          while (cursor < lines.length && lines[cursor].includes("|")) {
            var cells = lines[cursor].split("|").map(function (cell) {
              return cell.trim();
            });
            if (cells[0] === "") cells.shift();
            if (cells[cells.length - 1] === "") cells.pop();
            rows.push(cells);
            cursor += 1;
          }

          var tableHtml = ["<table><thead><tr>"];
          headers.forEach(function (cell) {
            tableHtml.push("<th>" + renderInline(cell) + "</th>");
          });
          tableHtml.push("</tr></thead><tbody>");
          rows.forEach(function (row) {
            tableHtml.push("<tr>");
            row.forEach(function (cell) {
              tableHtml.push("<td>" + renderInline(cell) + "</td>");
            });
            tableHtml.push("</tr>");
          });
          tableHtml.push("</tbody></table>");
          html.push(tableHtml.join(""));
          i = cursor - 1;
          continue;
        }

        paragraph.push(line);
      }

      if (inFence && fenceLines.length) {
        html.push("<pre><code>" + fenceLines.join("\n") + "</code></pre>");
      }
      flushParagraph();
      closeList();
      return html.join("");
    }

    // ── api ───────────────────────────────────────────────────────────────

    /**
     * Thin RPC wrapper. Endpoints are named, never URL-built, and a rejected
     * call surfaces the server's message instead of a generic failure.
     */
    function makeApi(rpc) {
      // DSH's connection RPC is call(channel, endpoint, payload, signal). The
      // channel is fixed and the endpoint is the pair after it, so a
      // pre-joined "/api/skill-hub/x" string would land the payload object in
      // the endpoint slot and fail inside the host's target validation.
      var call = function (endpoint, payload, signal) {
        return rpc.call("/api", "skill-hub/" + endpoint, payload || {}, signal).then(function (result) {
          if (result && result.ok) return result.value;
          var message = (result && result.error && result.error.message) || t("error.generic");
          var error = new Error(message);
          error.code = result && result.error && result.error.code;
          throw error;
        });
      };

      return {
        sources: function (signal) {
          return call("sources", {}, signal);
        },
        categories: function (signal) {
          return call("categories", {}, signal);
        },
        experts: function (signal) {
          return call("experts", {}, signal);
        },
        search: function (args, signal) {
          return call("search", args, signal);
        },
        detail: function (args, signal) {
          return call("detail", args, signal);
        },
        installed: function (signal) {
          return call("installed", {}, signal);
        },
        install: function (args, signal) {
          return call("install", args, signal);
        },
        uninstall: function (args, signal) {
          return call("uninstall", args, signal);
        }
      };
    }

    /** Build the server-side reference for an item. */
    function refOf(skill) {
      return {
        source: skill.source,
        slug: skill.slug,
        owner: skill.owner,
        repoRef: skill.repoRef,
        repoPath: skill.repoPath
      };
    }

    function sourceLabelOf(skill) {
      if (!skill) return "";
      return skill.sourceLabel || { skillhub: "SkillHub", clawhub: "ClawHub", github: "GitHub" }[skill.source] || skill.source || "";
    }

    function formatCount(value) {
      var n = Number(value || 0);
      if (!n) return "0";
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
      return String(n);
    }

    function pickSummary(skill) {
      return skill.summaryZh || skill.summary || "";
    }

    // ── small components ──────────────────────────────────────────────────

    function Spinner() {
      return h("span", { className: "dsh-sh-spinner", "aria-hidden": "true" });
    }

    function StateBlock(props) {
      return h(
        "div",
        { className: "dsh-sh-state" },
        props.loading ? h(Spinner, null) : null,
        h("div", null, props.text || "")
      );
    }

    function Toast(props) {
      var toast = props.toast || {};
      if (!toast.message) return null;
      return h("div", { className: "dsh-sh-toast", "data-tone": toast.tone || "info" }, toast.message);
    }

    function Avatar(props) {
      var skill = props.skill || {};
      var label = (skill.name || skill.slug || "?").trim().charAt(0).toUpperCase();
      if (skill.iconUrl) {
        return h("img", {
          className: "dsh-sh-avatar",
          src: skill.iconUrl,
          alt: "",
          loading: "lazy",
          referrerPolicy: "no-referrer",
          onError: function (event) {
            event.currentTarget.style.display = "none";
          }
        });
      }
      return h("span", { className: "dsh-sh-avatar-fallback", "aria-hidden": "true" }, label);
    }

    function SkillCard(props) {
      var skill = props.skill;
      var busy = props.busy;
      var onOpen = props.onOpen;
      var onInstall = props.onInstall;
      var onUninstall = props.onUninstall;

      return h(
        "div",
        {
          className: "dsh-sh-card",
          onClick: function () {
            onOpen(skill);
          }
        },
        h(
          "div",
          { className: "dsh-sh-card-head" },
          h(Avatar, { skill: skill }),
          h("span", { className: "dsh-sh-card-title", title: skill.name }, skill.name || skill.slug),
          skill.installed ? h("span", { className: "dsh-sh-badge", "data-tone": "installed" }, t("action.installed")) : null
        ),
        h("div", { className: "dsh-sh-card-desc" }, pickSummary(skill) || "—"),
        h(
          "div",
          { className: "dsh-sh-card-foot" },
          h("span", null, sourceLabelOf(skill)),
          skill.downloads ? h("span", null, "↓ " + formatCount(skill.downloads)) : null,
          h(
            "div",
            { className: "dsh-sh-card-actions" },
            skill.installed
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-sh-btn",
                    "data-variant": "danger",
                    disabled: busy,
                    onClick: function (event) {
                      event.stopPropagation();
                      onUninstall(skill);
                    }
                  },
                  busy ? t("loading") : t("action.uninstall")
                )
              : h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-sh-btn",
                    "data-variant": "primary",
                    disabled: busy,
                    onClick: function (event) {
                      event.stopPropagation();
                      onInstall(skill);
                    }
                  },
                  busy ? t("action.installing") : t("action.install")
                )
          )
        )
      );
    }

    function DetailView(props) {
      var detail = props.detail || {};
      var busy = props.busy;
      var onBack = props.onBack;
      var onInstall = props.onInstall;
      var onUninstall = props.onUninstall;

      var metaItems = []
      if (detail.version) metaItems.push([t("detail.version"), detail.version])
      if (detail.ownerName || detail.owner) metaItems.push([t("detail.author"), detail.ownerName || detail.owner])
      if (detail.category) metaItems.push([t("detail.category"), detail.category])
      if (detail.license) metaItems.push([t("detail.license"), detail.license])
      if (detail.downloadCount) metaItems.push([t("detail.downloads"), formatCount(detail.downloadCount)])
      if (detail.stars) metaItems.push([t("detail.stars"), formatCount(detail.stars)])
      metaItems.push([t("detail.source"), sourceLabelOf(detail)])

      return h(
        "div",
        { className: "dsh-sh-detail" },
        h(
          "div",
          { className: "dsh-sh-detail-head" },
          h(
            "button",
            { type: "button", className: "dsh-sh-btn", onClick: onBack },
            "← " + t("action.back")
          ),
          h(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            h("h2", { className: "dsh-sh-detail-title" }, detail.name || detail.slug),
            h("div", { className: "dsh-sh-detail-sub" }, pickSummary(detail) || detail.slug)
          ),
          detail.installed
            ? h(
                "button",
                {
                  type: "button",
                  className: "dsh-sh-btn",
                  "data-variant": "danger",
                  disabled: busy,
                  onClick: function () {
                    onUninstall(detail);
                  }
                },
                busy ? t("loading") : t("action.uninstall")
              )
            : h(
                "button",
                {
                  type: "button",
                  className: "dsh-sh-btn",
                  "data-variant": "primary",
                  disabled: busy,
                  onClick: function () {
                    onInstall(detail);
                  }
                },
                busy ? t("action.installing") : t("action.install")
              )
        ),
        metaItems.length
          ? h(
              "div",
              { className: "dsh-sh-meta" },
              metaItems.map(function (pair, index) {
                return h(
                  "div",
                  { className: "dsh-sh-meta-item", key: index },
                  h("span", { className: "dsh-sh-meta-key" }, pair[0]),
                  h("span", { className: "dsh-sh-meta-value" }, String(pair[1]))
                );
              })
            )
          : null,
        detail.tags && detail.tags.length
          ? h(
              "div",
              { className: "dsh-sh-meta" },
              detail.tags.slice(0, 12).map(function (tag, index) {
                return h("span", { className: "dsh-sh-badge", key: index }, String(tag));
              })
            )
          : null,
        h(
          "div",
          null,
          h("div", { className: "dsh-sh-section-title" }, t("detail.readme")),
          detail.readme
            ? h("div", {
                className: "dsh-sh-md",
                dangerouslySetInnerHTML: { __html: renderMarkdown(detail.readme) }
              })
            : h("div", { className: "dsh-sh-state" }, detail.readmeError || t("detail.readmeEmpty"))
        )
      );
    }

    // ── main page ─────────────────────────────────────────────────────────

    function SkillHubPage(props) {
      var rpc = props.rpc;
      var api = useMemo(
        function () {
          return makeApi(rpc);
        },
        [rpc]
      );

      var tabState = useState("market");
      var tab = tabState[0];
      var setTab = tabState[1];

      var keywordState = useState("");
      var keyword = keywordState[0];
      var setKeyword = keywordState[1];

      var sourceState = useState("");
      var activeSource = sourceState[0];
      var setActiveSource = sourceState[1];

      var categoryState = useState("");
      var activeCategory = categoryState[0];
      var setActiveCategory = categoryState[1];

      var sourcesState = useState([]);
      var sources = sourcesState[0];
      var setSources = sourcesState[1];

      var categoriesState = useState([]);
      var categories = categoriesState[0];
      var setCategories = categoriesState[1];

      // The roster is a separate catalogue served by its own endpoint, so it
      // keeps its own slice of state instead of being folded into the search
      // list (which is paged and filtered by source/category).
      var rosterState = useState(null);
      var roster = rosterState[0];
      var setRoster = rosterState[1];

      var deptState = useState("");
      var activeDept = deptState[0];
      var setActiveDept = deptState[1];

      var rosterErrorState = useState("");
      var rosterError = rosterErrorState[0];
      var setRosterError = rosterErrorState[1];

      var expertQueryState = useState("");
      var expertQuery = expertQueryState[0];
      var setExpertQuery = expertQueryState[1];

      var itemsState = useState([]);
      var items = itemsState[0];
      var setItems = itemsState[1];

      var pageState = useState(1);
      var page = pageState[0];
      var setPage = pageState[1];

      var hasMoreState = useState(false);
      var hasMore = hasMoreState[0];
      var setHasMore = hasMoreState[1];

      var loadingState = useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];

      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];

      var sourceErrorsState = useState([]);
      var sourceErrors = sourceErrorsState[0];
      var setSourceErrors = sourceErrorsState[1];

      var detailState = useState(null);
      var detail = detailState[0];
      var setDetail = detailState[1];

      var installedState = useState(null);
      var installed = installedState[0];
      var setInstalled = installedState[1];

      var busyState = useState({});
      var busy = busyState[0];
      var setBusy = busyState[1];

      var toastState = useState({});
      var toast = toastState[0];
      var setToast = toastState[1];

      var requestRef = useRef(0);
      var toastTimer = useRef(null);

      var showToast = useCallback(function (message, tone) {
        setToast({ message: message, tone: tone || "info" });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(function () {
          setToast({});
        }, 3200);
      }, []);

      useEffect(
        function () {
          return function () {
            if (toastTimer.current) clearTimeout(toastTimer.current);
          };
        },
        []
      );

      // Static reference data: fetched once, independently of the search loop.
      useEffect(
        function () {
          var controller = new AbortController();
          api
            .sources(controller.signal)
            .then(function (value) {
              setSources((value && value.sources) || []);
            })
            .catch(function () {
              setSources([]);
            });
          api
            .categories(controller.signal)
            .then(function (value) {
              setCategories((value && value.categories) || []);
            })
            .catch(function () {
              setCategories([]);
            });
          return function () {
            controller.abort();
          };
        },
        [api]
      );

      var runSearch = useCallback(
        function (nextPage, append) {
          var token = requestRef.current + 1;
          requestRef.current = token;

          setLoading(true);
          setError("");

          var args = {
            keyword: keyword,
            page: nextPage,
            pageSize: 30,
            source: activeSource || undefined,
            category: activeCategory || undefined
          };

          return api
            .search(args)
            .then(function (value) {
              if (requestRef.current !== token) return;
              var incoming = (value && value.items) || [];
              setItems(function (previous) {
                if (!append) return incoming;
                var seen = new Set(
                  previous.map(function (skill) {
                    return skill.id;
                  })
                );
                return previous.concat(
                  incoming.filter(function (skill) {
                    return !seen.has(skill.id);
                  })
                );
              });
              setHasMore(!!(value && value.hasMore));
              setPage(nextPage);
              setSourceErrors((value && value.errors) || []);
            })
            .catch(function (failure) {
              if (requestRef.current !== token) return;
              setError((failure && failure.message) || t("error.generic"));
              if (!append) setItems([]);
              setHasMore(false);
            })
            .finally(function () {
              if (requestRef.current === token) setLoading(false);
            });
        },
        [api, keyword, activeSource, activeCategory]
      );

      // Debounce typing; switch a filter and the search fires immediately.
      useEffect(
        function () {
          if (tab !== "market") return undefined;
          var timer = setTimeout(function () {
            runSearch(1, false);
          }, keyword ? 260 : 0);
          return function () {
            clearTimeout(timer);
          };
        },
        [tab, keyword, activeSource, activeCategory, runSearch]
      );

      // The installed list is only fetched when its tab is actually opened.
      var loadInstalled = useCallback(
        function () {
          setLoading(true);
          setError("");
          return api
            .installed()
            .then(function (value) {
              setInstalled(value || { skills: [], dir: "" });
            })
            .catch(function (failure) {
              setError((failure && failure.message) || t("error.generic"));
              setInstalled({ skills: [], dir: "" });
            })
            .finally(function () {
              setLoading(false);
            });
        },
        [api]
      );

      useEffect(
        function () {
          if (tab !== "installed") return;
          loadInstalled();
        },
        [tab, loadInstalled]
      );

      // The roster is fetched once and kept: it is a fixed curated list, and
      // re-fetching it on every tab switch would spend API quota for nothing.
      var loadRoster = useCallback(
        function (force) {
          if (roster && !force) return undefined;
          setRosterError("");
          return api
            .experts()
            .then(function (value) {
              setRoster(value || { departments: [], experts: [], total: 0 });
            })
            .catch(function (failure) {
              setRosterError((failure && failure.message) || t("error.generic"));
              setRoster({ departments: [], experts: [], total: 0 });
            });
        },
        [api, roster]
      );

      useEffect(
        function () {
          if (tab !== "experts") return;
          loadRoster(false);
        },
        [tab, loadRoster]
      );

      var markBusy = function (key, value) {
        setBusy(function (previous) {
          var next = {};
          Object.keys(previous).forEach(function (name) {
            next[name] = previous[name];
          });
          next[key] = value;
          return next;
        });
      };

      var handleInstall = useCallback(
        function (skill) {
          var key = "install:" + skill.id;
          markBusy(key, true);
          api
            .install(refOf(skill))
            .then(function (value) {
              showToast(t("toast.installed", { name: (value && value.name) || skill.name || skill.slug }), "info");
              setItems(function (previous) {
                return previous.map(function (item) {
                  return item.id === skill.id ? { ...item, installed: true } : item;
                });
              });
              setDetail(function (previous) {
                return previous && previous.id === skill.id ? { ...previous, installed: true } : previous;
              });
              setInstalled(null);
              // The roster keeps its own copy of the installed flag, so it has
              // to be nudged too or the expert row would still offer Install.
              setRoster(function (previous) {
                if (!previous || !previous.experts) return previous;
                return {
                  ...previous,
                  experts: previous.experts.map(function (item) {
                    return item.stem === skill.slug ? { ...item, installed: true } : item;
                  })
                };
              });
            })
            .catch(function (failure) {
              showToast(t("toast.failed", { message: (failure && failure.message) || "" }), "error");
            })
            .finally(function () {
              markBusy(key, false);
            });
        },
        [api, showToast]
      );

      var handleUninstall = useCallback(
        function (skill) {
          var key = "uninstall:" + skill.id;
          markBusy(key, true);
          api
            .uninstall({ slug: skill.slug })
            .then(function () {
              showToast(t("toast.uninstalled", { name: skill.name || skill.slug }), "info");
              setItems(function (previous) {
                return previous.map(function (item) {
                  return item.id === skill.id ? { ...item, installed: false } : item;
                });
              });
              setDetail(function (previous) {
                return previous && previous.id === skill.id ? { ...previous, installed: false } : previous;
              });
              setRoster(function (previous) {
                if (!previous || !previous.experts) return previous;
                return {
                  ...previous,
                  experts: previous.experts.map(function (item) {
                    return item.stem === skill.slug ? { ...item, installed: false } : item;
                  })
                };
              });
              if (tab === "installed") loadInstalled();
            })
            .catch(function (failure) {
              showToast(t("toast.failed", { message: (failure && failure.message) || "" }), "error");
            })
            .finally(function () {
              markBusy(key, false);
            });
        },
        [api, showToast, tab, loadInstalled]
      );

      var openDetail = useCallback(
        function (skill) {
          setDetail({ id: skill.id, name: skill.name, slug: skill.slug, source: skill.source, installed: skill.installed, loading: true });
          // Seed from the card so the header renders instantly, then replace.
          api
            .detail(refOf(skill))
            .then(function (value) {
              setDetail({ ...(value || {}), id: skill.id, loading: false });
            })
            .catch(function (failure) {
              setDetail({
                id: skill.id,
                name: skill.name,
                slug: skill.slug,
                source: skill.source,
                loading: false,
                readmeError: (failure && failure.message) || t("error.generic")
              });
            });
        },
        [api]
      );

      var isBusy = function (skill, verb) {
        return !!(skill && busy[verb + ":" + skill.id]);
      };

      var showCategories = tab === "market" && (!activeSource || activeSource === "skillhub");
      var visibleCategories = categories.filter(function (entry) {
        return !!entry.key;
      });

      var marketBody;
      if (detail) {
        if (detail.loading) {
          marketBody = h(StateBlock, { loading: true, text: t("loading") });
        } else {
          marketBody = h(DetailView, {
            detail: detail,
            busy: isBusy(detail, "install") || isBusy(detail, "uninstall"),
            onBack: function () {
              setDetail(null);
            },
            onInstall: handleInstall,
            onUninstall: handleUninstall
          });
        }
      } else if (loading && !items.length) {
        marketBody = h(StateBlock, { loading: true, text: t("loading") });
      } else if (error && !items.length) {
        marketBody = h(
          "div",
          { className: "dsh-sh-state" },
          h("div", null, error),
          h(
            "button",
            {
              type: "button",
              className: "dsh-sh-btn",
              onClick: function () {
                runSearch(1, false);
              }
            },
            t("action.retry")
          )
        );
      } else if (!items.length) {
        marketBody = h(
          "div",
          { className: "dsh-sh-state" },
          h("div", null, t("empty.market")),
          h("div", null, t("empty.hint"))
        );
      } else {
        marketBody = h(
          "div",
          { className: "dsh-sh-list" },
          h(
            "div",
            { className: "dsh-sh-grid" },
            items.map(function (skill) {
              return h(SkillCard, {
                key: skill.id,
                skill: skill,
                busy: isBusy(skill, "install") || isBusy(skill, "uninstall"),
                onOpen: openDetail,
                onInstall: handleInstall,
                onUninstall: handleUninstall
              });
            })
          ),
          hasMore
            ? h(
                "div",
                { style: { display: "flex", justifyContent: "center", marginTop: 12 } },
                h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-sh-btn",
                    disabled: loading,
                    onClick: function () {
                      runSearch(page + 1, true);
                    }
                  },
                  loading ? t("loading") : t("action.loadMore")
                )
              )
            : null
        );
      }

      var installedList = (installed && installed.skills) || [];
      var installedBody;
      if (installed === null || (loading && !installedList.length)) {
        installedBody = h(StateBlock, { loading: true, text: t("loading") });
      } else if (!installedList.length) {
        installedBody = h("div", { className: "dsh-sh-state" }, h("div", null, t("empty.installed")));
      } else {
        installedBody = h(
          "div",
          { className: "dsh-sh-list" },
          installed && installed.dir
            ? h(
                "div",
                { className: "dsh-sh-detail-sub" },
                t("installed.dir") + " · " + installed.dir
              )
            : null,
          installedList.map(function (skill) {
            return h(
              "div",
              { className: "dsh-sh-row", key: skill.slug },
              h(Avatar, { skill: skill }),
              h(
                "div",
                { className: "dsh-sh-row-body" },
                h("div", { className: "dsh-sh-row-title" }, skill.name || skill.slug),
                h("div", { className: "dsh-sh-row-desc" }, pickSummary(skill) || skill.sourceLabel || "")
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-sh-btn",
                  "data-variant": "danger",
                  disabled: !!busy["uninstall:" + skill.slug],
                  onClick: function () {
                    handleUninstall({ ...skill, id: skill.slug });
                  }
                },
                busy["uninstall:" + skill.slug] ? t("loading") : t("action.uninstall")
              )
            );
          })
        );
      }

      // ── experts ─────────────────────────────────────────────────────────
      // The roster is one flat array of 328 entries carrying their department,
      // so it is filtered here and grouped for display rather than paged: it
      // is small enough that a local filter is faster than a round trip.
      var rosterExperts = (roster && roster.experts) || [];
      var rosterDepts = (roster && roster.departments) || [];
      var rosterRef = (roster && roster.ref) || "";
      var expertNeedle = expertQuery.trim().toLowerCase();

      var expertItems = rosterExperts
        .filter(function (expert) {
          if (activeDept && expert.deptKey !== activeDept) return false;
          if (!expertNeedle) return true;
          return (
            String(expert.name || "").toLowerCase().indexOf(expertNeedle) >= 0 ||
            String(expert.stem || "").toLowerCase().indexOf(expertNeedle) >= 0 ||
            String(expert.summary || "").toLowerCase().indexOf(expertNeedle) >= 0
          );
        })
        .map(function (expert) {
          return {
            id: "experts:" + expert.stem,
            source: "experts",
            slug: expert.stem,
            name: expert.name || expert.stem,
            summary: expert.summary || "",
            emoji: expert.emoji || "🧑‍💼",
            deptKey: expert.deptKey || "",
            deptLabel: expert.deptLabel || "",
            repoPath: expert.path,
            repoRef: rosterRef,
            installed: !!expert.installed
          };
        });

      var expertGroups = [];
      if (activeDept) {
        expertGroups.push({ key: activeDept, label: "", experts: expertItems });
      } else {
        rosterDepts.forEach(function (dept) {
          var members = expertItems.filter(function (expert) {
            return expert.deptKey === dept.key;
          });
          if (members.length) {
            expertGroups.push({ key: dept.key, label: dept.label, experts: members });
          }
        });
      }

      var renderExpertRow = function (expert) {
        var installing = isBusy(expert, "install");
        return h(
          "div",
          {
            className: "dsh-sh-row",
            key: expert.id,
            "data-clickable": "",
            onClick: function () {
              openDetail(expert);
            }
          },
          h("span", { className: "dsh-sh-expert-emoji", "aria-hidden": "true" }, expert.emoji),
          h(
            "div",
            { className: "dsh-sh-row-body" },
            h("div", { className: "dsh-sh-row-title" }, expert.name),
            h("div", { className: "dsh-sh-row-desc" }, expert.summary || expert.slug)
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-sh-btn",
              disabled: installing || expert.installed,
              onClick: function (event) {
                event.stopPropagation();
                handleInstall(expert);
              }
            },
            expert.installed ? t("experts.installed") : installing ? t("action.installing") : t("action.install")
          )
        );
      };

      var expertsBody;
      if (detail && detail.source === "experts") {
        if (detail.loading) {
          expertsBody = h(StateBlock, { loading: true, text: t("loading") });
        } else {
          expertsBody = h(DetailView, {
            detail: detail,
            busy: isBusy(detail, "install") || isBusy(detail, "uninstall"),
            onBack: function () {
              setDetail(null);
            },
            onInstall: handleInstall,
            onUninstall: handleUninstall
          });
        }
      } else if (roster === null) {
        expertsBody = h(StateBlock, { loading: true, text: t("loading") });
      } else if (rosterError && !rosterExperts.length) {
        expertsBody = h(
          "div",
          { className: "dsh-sh-state" },
          h("div", null, rosterError),
          h(
            "button",
            {
              type: "button",
              className: "dsh-sh-btn",
              onClick: function () {
                setRoster(null);
                loadRoster(true);
              }
            },
            t("action.retry")
          )
        );
      } else if (!rosterExperts.length) {
        expertsBody = h(
          "div",
          { className: "dsh-sh-state" },
          h("div", null, t("experts.empty")),
          h("div", null, t("experts.hint"))
        );
      } else if (!expertItems.length) {
        expertsBody = h("div", { className: "dsh-sh-state" }, h("div", null, t("experts.noMatch")));
      } else {
        expertsBody = h(
          "div",
          { className: "dsh-sh-list" },
          h("div", { className: "dsh-sh-expert-note" }, t("experts.hint")),
          expertGroups.map(function (group) {
            return h(
              "div",
              { key: group.key || "all" },
              group.label ? h("div", { className: "dsh-sh-group-title" }, group.label) : null,
              group.experts.map(renderExpertRow)
            );
          })
        );
      }

      var expertsAside = rosterExperts.length
        ? h(
            "aside",
            { className: "dsh-sh-cats" },
            h(
              "button",
              {
                type: "button",
                className: "dsh-sh-cat",
                "data-active": !activeDept ? "" : undefined,
                onClick: function () {
                  setActiveDept("");
                  setDetail(null);
                }
              },
              t("experts.dept.all")
            ),
            rosterDepts.map(function (dept) {
              return h(
                "button",
                {
                  type: "button",
                  className: "dsh-sh-cat",
                  key: dept.key || dept.label,
                  "data-active": activeDept === dept.key ? "" : undefined,
                  onClick: function () {
                    setActiveDept(dept.key);
                    setDetail(null);
                  }
                },
                (dept.emoji ? dept.emoji + " " : "") + (dept.label || dept.key)
              );
            })
          )
        : null;

      return h(
        "div",
        { className: "dsh-sh-page", style: { position: "relative" } },
        h(Styles, null),
        h(
          "div",
          { className: "dsh-sh-top" },
          h(
            "div",
            { className: "dsh-sh-title-row" },
            h("h1", { className: "dsh-sh-heading" }, t("panel.title")),
            h(
              "div",
              { className: "dsh-sh-tabs", role: "tablist" },
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-sh-tab",
                  role: "tab",
                  "data-active": tab === "market" ? "" : undefined,
                  onClick: function () {
                    setTab("market");
                    setDetail(null);
                  }
                },
                t("tab.market")
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-sh-tab",
                  role: "tab",
                  "data-active": tab === "experts" ? "" : undefined,
                  onClick: function () {
                    setTab("experts");
                    setDetail(null);
                  }
                },
                t("tab.experts")
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-sh-tab",
                  role: "tab",
                  "data-active": tab === "installed" ? "" : undefined,
                  onClick: function () {
                    setTab("installed");
                    setDetail(null);
                  }
                },
                t("tab.installed")
              )
            )
          ),
          tab === "market"
            ? h(
                "div",
                { className: "dsh-sh-search-row" },
                h(
                  "div",
                  { className: "dsh-sh-search" },
                  h("input", {
                    className: "dsh-sh-search-input",
                    type: "search",
                    value: keyword,
                    placeholder: t("search.placeholder"),
                    onChange: function (event) {
                      setKeyword(event.target.value);
                      setDetail(null);
                    }
                  }),
                  keyword
                    ? h(
                        "button",
                        {
                          type: "button",
                          className: "dsh-sh-search-clear",
                          title: t("search.clear"),
                          onClick: function () {
                            setKeyword("");
                          }
                        },
                        "×"
                      )
                    : null
                ),
                h(
                  "div",
                  { className: "dsh-sh-sources" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dsh-sh-chip",
                      "data-active": !activeSource ? "" : undefined,
                      onClick: function () {
                        setActiveSource("");
                        setDetail(null);
                      }
                    },
                    t("source.all")
                  ),
                  sources.map(function (source) {
                    return h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-sh-chip",
                        key: source.id,
                        "data-active": activeSource === source.id ? "" : undefined,
                        onClick: function () {
                          setActiveSource(source.id);
                          setDetail(null);
                        }
                      },
                      source.label || source.id
                    );
                  })
                )
              )
            : tab === "experts"
              ? h(
                  "div",
                  { className: "dsh-sh-search-row" },
                  h(
                    "div",
                    { className: "dsh-sh-search" },
                    h("input", {
                      className: "dsh-sh-search-input",
                      type: "search",
                      value: expertQuery,
                      placeholder: t("experts.placeholder"),
                      onChange: function (event) {
                        setExpertQuery(event.target.value);
                      }
                    }),
                    expertQuery
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "dsh-sh-search-clear",
                            title: t("search.clear"),
                            onClick: function () {
                              setExpertQuery("");
                            }
                          },
                          "×"
                        )
                      : null
                  )
                )
              : null
        ),
        h(
          "div",
          { className: "dsh-sh-body" },
          showCategories
            ? h(
                "aside",
                { className: "dsh-sh-cats" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-sh-cat",
                    "data-active": !activeCategory ? "" : undefined,
                    onClick: function () {
                      setActiveCategory("");
                      setDetail(null);
                    }
                  },
                  t("category.all")
                ),
                visibleCategories.map(function (entry) {
                  return h(
                    "button",
                    {
                      type: "button",
                      className: "dsh-sh-cat",
                      key: entry.key,
                      "data-active": activeCategory === entry.key ? "" : undefined,
                      title: entry.nameEn || entry.name,
                      onClick: function () {
                        setActiveCategory(entry.key);
                        setDetail(null);
                      }
                    },
                    entry.name || entry.key
                  );
                })
              )
            : null,
          tab === "experts" ? expertsAside : null,
          h(
            "div",
            { className: "dsh-sh-main" },
            sourceErrors.length
              ? h(
                  "div",
                  { className: "dsh-sh-error" },
                  t("error.partial") +
                    " · " +
                    sourceErrors
                      .map(function (entry) {
                        return entry.source + ": " + entry.error;
                      })
                      .join("; ")
                )
              : null,
            tab === "market" ? marketBody : tab === "installed" ? installedBody : expertsBody
          )
        ),
        h(Toast, { toast: toast })
      );
    }

    // ── sidebar glyph ─────────────────────────────────────────────────────

    /** The shell passes { size, active }; draw at that size in currentColor. */
    function SkillHubIcon(props) {
      var size = (props && props.size) || 16;
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.3",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block" }
        },
        h("path", { d: "M9 1.5L3 9h4.5l-1 5.5L13 7H8.5l.5-5.5z" })
      );
    }

    // ── composer chip ─────────────────────────────────────────────────────

    function ChatInputButton(props) {
      var rpc = props.rpc;
      var inputActions = props.inputActions;
      var openPanel = props.openPanel;
      var openState = useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var skillsState = useState([]);
      var skills = skillsState[0];
      var setSkills = skillsState[1];
      var rosterState = useState(null);
      var roster = rosterState[0];
      var setRoster = rosterState[1];
      var pickerTabState = useState("skills");
      var pickerTab = pickerTabState[0];
      var setPickerTab = pickerTabState[1];
      var queryState = useState("");
      var query = queryState[0];
      var setQuery = queryState[1];
      var containerRef = useRef(null);

      var api = useMemo(
        function () {
          return makeApi(rpc);
        },
        [rpc]
      );

      useEffect(
        function () {
          if (!open) return undefined;
          var controller = new AbortController();
          api
            .installed(controller.signal)
            .then(function (value) {
              setSkills((value && value.skills) || []);
            })
            .catch(function () {
              setSkills([]);
            });
          return function () {
            controller.abort();
          };
        },
        [open, api]
      );

      // The roster is only pulled when its tab is actually opened. It is a few
      // hundred entries, which is wasteful for someone who only wants to reach
      // a skill they already installed.
      useEffect(
        function () {
          if (!open || pickerTab !== "experts" || roster) return undefined;
          var controller = new AbortController();
          api
            .experts(controller.signal)
            .then(function (value) {
              setRoster((value && value.experts) || []);
            })
            .catch(function () {
              setRoster([]);
            });
          return function () {
            controller.abort();
          };
        },
        [open, pickerTab, roster, api]
      );

      useEffect(
        function () {
          if (!open) return undefined;
          var onPointerDown = function (event) {
            if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
          };
          document.addEventListener("pointerdown", onPointerDown);
          return function () {
            document.removeEventListener("pointerdown", onPointerDown);
          };
        },
        [open]
      );

      var insertSkill = function (skill) {
        var name = skill.slug || skill.stem || skill.name;
        if (inputActions && typeof inputActions.setDraft === "function") {
          inputActions.setDraft("/" + name + " ");
        }
        setOpen(false);
      };

      var expertRows = (roster || []).filter(function (expert) {
        var needle = query.trim().toLowerCase();
        if (!needle) return true;
        return (
          String(expert.name || "").toLowerCase().indexOf(needle) >= 0 ||
          String(expert.stem || "").toLowerCase().indexOf(needle) >= 0
        );
      });

      var rows = pickerTab === "experts" ? expertRows : skills;

      return h(
        "div",
        { ref: containerRef, style: { position: "relative", display: "inline-flex" } },
        h(Styles, null),
        h(
          "button",
          {
            type: "button",
            className: "dsh-sh-composer-btn dsh-sh-composer-icon",
            title: t("composer.hint"),
            "aria-label": t("composer.button"),
            onClick: function () {
              setOpen(!open);
            }
          },
          h(SkillHubIcon, { size: 14 })
        ),
        open
          ? h(
              "div",
              { className: "dsh-sh-picker" },
              h(
                "div",
                { className: "dsh-sh-picker-tabs" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-sh-picker-tab",
                    "data-active": pickerTab === "skills" ? "" : undefined,
                    onClick: function () {
                      setPickerTab("skills");
                    }
                  },
                  t("composer.browseSkills")
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-sh-picker-tab",
                    "data-active": pickerTab === "experts" ? "" : undefined,
                    onClick: function () {
                      setPickerTab("experts");
                    }
                  },
                  t("composer.browseExperts")
                )
              ),
              pickerTab === "experts"
                ? h("input", {
                    className: "dsh-sh-picker-search",
                    type: "search",
                    value: query,
                    placeholder: t("experts.placeholder"),
                    onChange: function (event) {
                      setQuery(event.target.value);
                    }
                  })
                : null,
              rows.length
                ? rows.map(function (row) {
                    var key = pickerTab === "experts" ? row.stem : row.slug;
                    var label = pickerTab === "experts" ? row.name || row.stem : row.name || row.slug;
                    return h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-sh-picker-item",
                        key: key,
                        onClick: function () {
                          insertSkill(row);
                        }
                      },
                      label
                    );
                  })
                : h(
                    "div",
                    { className: "dsh-sh-picker-empty" },
                    pickerTab === "experts" ? t("experts.noMatch") : t("empty.installed")
                  )
            )
          : null
      );
    }

    // ── plugin entry ──────────────────────────────────────────────────────

    var inject = ["slots", "connection"];

    var PANEL_ID = "skill-hub";

    function apply(ctx) {
      bindLocale(ctx);

      var rpc = ctx.get("connection").rpc;

      ctx.effect(function () {
        return ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: -1,
              label: function () {
                return t("panel.title");
              }
            },
            SkillHubIcon
          );
        });
      }, "dsh-skill-hub: sidebar row");

      ctx.effect(function () {
        return ctx.slots.inject("main", function () {
          return ctx.slots.register(
            {
              name: "main",
              key: PANEL_ID,
              inject: function () {
                return { rpc: rpc };
              }
            },
            SkillHubPage
          );
        });
      }, "dsh-skill-hub: main page");

      ctx.effect(function () {
        return ctx.slots.inject("conversation.input.left", function () {
          return ctx.slots.register(
            {
              name: "conversation.input.left",
              id: PANEL_ID,
              order: 100,
              inject: function () {
                return { rpc: rpc };
              }
            },
            ChatInputButton
          );
        });
      }, "dsh-skill-hub: composer chip");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
