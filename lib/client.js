window.__ModuleLoader__.load({
  id: "dsh-unified-quota",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const h = react.createElement;
    let P = {};
    try { P = require("@deepseek-ai/dsh-client-ui-primitives") || {}; } catch (e) { P = {}; }
    const GlyphRefresh = [P.IconRefreshOutlineRegular, P.IconRefreshOutlineMedium, P.IconRefreshOutline14]
      .find(function (g) { return typeof g === "function" || (typeof g === "object" && g !== null); });
    const Tip = typeof P.Tooltip === "function" || (typeof P.Tooltip === "object" && P.Tooltip !== null) ? P.Tooltip : null;
    /**
     * 悬停说明的**唯一**正确做法：写原生 title。
     *
     * 为什么不自己画气泡、也不用组件的 Tooltip：
     * 本插件的弹层是 position:fixed 且内部有滚动容器，实测两条路都会出问题——
     *   · 自研 fixed 定位：随页面缩放/容器变换偏离指针，且每帧强制布局导致抖动；
     *   · 组件的 Tooltip：在该上下文里定位到屏幕边缘（截图实测），同样不可用。
     * 原生 title 由浏览器/系统负责定位与渲染：不漂移、不抖动、不被 overflow 裁切。
     * 代价是样式跟随系统主题，而不是 DSH 主题 —— 稳定性优先。
     *
     * 后续新增说明时：**直接给节点加 title 属性**，或调用 hint()，不要自研定位。
     */
    function tip(label, node) {
      if (!label || node === null || node === undefined) return node;
      try {
        // ⚠️ React element 的字段名是 props（不是 p）。
        // 之前误用 node.p 判定 ⇒ 恒为 undefined ⇒ tip() 一直原样返回，从未生效过。
        const hasProps = typeof node === "object" && node !== null
          && (node.props !== undefined || node.p !== undefined);
        if (hasProps) {
          const key = node.props !== undefined ? "props" : "p";
          const cur = node[key] || {};
          const cls = (cur.className ? cur.className + " " : "") + "uq-tip-anchor";
          // 只写 data-tip，不写 title：否则浏览器原生提示与 JS 气泡会同时弹出（双重重叠）。
          node[key] = Object.assign({}, cur, { "data-tip": label, className: cls });
          return node;
        }
      } catch (e) { /* 忽略 */ }
      return node;
    }
    /**
     * 全局单例悬停气泡。
     *
     * 为什么不用纯 CSS ::after：本插件的明细弹窗 .uq-dlg 与输入框 dock 都有
     * overflow:hidden，绝对定位的伪元素会被裁切 ⇒ 用户看不到任何提示。
     *
     * 与之前失败版本的区别：
     *   · 用 mouseenter/mouseleave（不是 pointerover/pointermove），**不跟踪指针**
     *   · 只在进入时读一次 getBoundingClientRect 定位，之后不重算
     *   · 气泡 pointer-events:none，不会被指针碰到 ⇒ 不会自我触发离开
     *   · portal 到 document.body，不受任何祖先 overflow/transform 影响
     */
    let tipLayerEl = null;
    let lastPointer = null; // { x, y }：最近一次鼠标位置，供气泡定位
    function ensureTipLayer() {
      if (tipLayerEl !== null) return tipLayerEl;
      try {
        const box = document.createElement("div");
        // 对齐 DSH 本体 tooltip 的视觉：深黑底 + 白字 + 无边框 + 紧凑
        box.style.cssText = [
          "position:fixed", "z-index:2147483000", "pointer-events:none", "display:none",
          "max-width:320px", "padding:4px 8px", "border-radius:4px",
          "font-size:12px", "line-height:18px", "white-space:pre-wrap", "word-break:break-word",
          "background:rgba(24,24,27,0.96)",
          "color:#f4f4f5",
          "border:none",
          "box-shadow:0 4px 16px rgba(0,0,0,.35)",
        ].join(";");
        document.body.appendChild(box);
        const show = function (el, text) {
          box.textContent = text;
          box.style.display = "block";
          // 只算一次：优先下方，放不下则上方
          // DSH 本体：气泡贴在指针右下方（不是元素左对齐）
          const r = el.getBoundingClientRect();
          const w = box.offsetWidth || 0;
          const h2 = box.offsetHeight || 0;
          // 指针位置优先（鼠标事件已记录），否则退回元素中心
          const px = (lastPointer && lastPointer.x) || (r.left + r.width / 2);
          const py = (lastPointer && lastPointer.y) || (r.top + r.height / 2);
          let left = Math.round(px + 12);
          if (left + w > window.innerWidth - 8) left = Math.max(8, Math.round(px - w - 12));
          let top = Math.round(py + 20);
          if (top + h2 > window.innerHeight - 8) top = Math.max(8, Math.round(py - h2 - 12));
          box.style.left = left + "px";
          box.style.top = top + "px";
        };
        const hide = function () { box.style.display = "none"; };
        // 事件委托：mouseenter 不冒泡，用 mouseover + relatedTarget 判定
        document.addEventListener("mousemove", function (e) { lastPointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
        document.addEventListener("mouseover", function (e) {
          const t = e.target;
          if (!t || typeof t.closest !== "function") return;
          const el = t.closest("[data-tip]");
          if (el === null) { hide(); return; }
          const text = el.getAttribute("data-tip");
          if (!text) { hide(); return; }
          show(el, text);
        }, true);
        document.addEventListener("mouseout", function (e) {
          const t = e.target;
          if (!t || typeof t.closest !== "function") return;
          const el = t.closest("[data-tip]");
          if (el === null) return;
          const rel = e.relatedTarget;
          if (rel && typeof el.contains === "function" && el.contains(rel)) return;
          hide();
        }, true);
        document.addEventListener("mousedown", hide, true);
        window.addEventListener("scroll", hide, true);
        window.addEventListener("resize", hide);
        tipLayerEl = box;
        return tipLayerEl;
      } catch (e) { return null; }
    }
    /** 生成一个可直接展开的 title 属性对象，供新功能使用。 */
    function hint(label) { return { "data-tip": label }; }
    //#region styles — tokens only; every color has a hard fallback via var()
    const css = [
      ".uq-root{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".uq-bar{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#333);background:var(--dsw-alias-bg-layer-2,#1b1b1f);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:16px}",
      ".uq-bar:hover{background:var(--dsw-alias-bg-layer-3,#242429)}",
      ".uq-seg{display:inline-flex;align-items:center;gap:4px;min-width:0;white-space:nowrap}",
      ".uq-dim{color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".uq-num{font-variant-numeric:tabular-nums;font-weight:600}",
      ".uq-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none}",
      ".uq-dot[data-ok=1]{background:var(--dsw-alias-state-success-primary,#34c77b)}",
      ".uq-dot[data-ok=0]{background:var(--dsw-alias-state-warn-primary,#bfa557)}",
      ".uq-dot[data-ok=x]{background:var(--dsw-alias-label-tertiary,#666)}",
      ".uq-pop{position:fixed;z-index:23000;width:380px;max-width:calc(100vw - 24px);max-height:72vh;overflow:auto;padding:12px 14px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,#3a3a41);background:var(--dsw-alias-bg-base,#151519);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.45));font-size:12px;line-height:18px}",
      ".uq-h{display:flex;align-items:center;justify-content:space-between;margin:10px 0 6px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#b3b3bd);text-transform:none}",
      ".uq-h:first-child{margin-top:0}",
      ".uq-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0}",
      ".uq-l{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".uq-v{font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".uq-track{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,#2b2b31);overflow:hidden;margin-top:3px}",
      ".uq-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".uq-fill[data-warn=1]{background:var(--dsw-alias-state-warn-primary,#bfa557)}",
      ".uq-fill[data-danger=1]{background:var(--dsw-alias-state-error-primary,#f56c6c)}",
      ".uq-sub{color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:11px}",
      ".uq-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px}",
      ".uq-card{border:1px solid var(--dsw-alias-border-l1,#333);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#1c1c21)}",
      ".uq-big{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;line-height:22px}",
      ".uq-btn{background:none;border:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#b3b3bd);display:inline-flex;align-items:center;padding:2px;border-radius:6px}",
      ".uq-btn:hover{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#26262c)}",
      ".uq-err{color:var(--dsw-alias-state-warn-primary,#bfa557);font-size:11px;margin-top:4px}",
      ".uq-models{margin:2px 0 4px 14px;display:flex;flex-direction:column;gap:1px}",
      ".uq-mrow{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary,#b3b3bd);font-size:11px}",
      ".uq-caret{display:inline-block;width:10px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".uq-more{width:100%;margin-top:6px;padding:5px 8px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2,#3a3a41);background:none;color:var(--dsw-alias-label-secondary,#b3b3bd);font-size:11px;cursor:pointer}",
      ".uq-more:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary,#e6e6e6)}",
      ".uq-sheet{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.55);animation:uqFade .16s ease-out;backdrop-filter:blur(3px);pointer-events:auto}",
      ".uq-sheet,.uq-sheet *{pointer-events:auto}",
      ".uq-dlg{position:relative;width:min(920px,calc(100vw - 48px));min-width:420px;min-height:320px;max-width:calc(100vw - 32px);max-height:92vh;resize:both;overflow:hidden;display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#4a4a53);border-top:2px solid rgba(77,107,254,.55);background:var(--dsw-alias-bg-base,#151519);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:0 32px 80px rgba(0,0,0,.62),0 0 0 1px rgba(0,0,0,.35),0 0 24px rgba(0,0,0,.28)}",
      ".uq-dlg-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#333);cursor:grab;user-select:none;flex:none}",
      ".uq-dlg-top:active{cursor:grabbing}",
      ".uq-dlg-top button,.uq-dlg-top select,.uq-dlg-top .uq-seg2{cursor:pointer}",
      // 底部状态栏：左侧信息，右侧操作
      ".uq-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 16px;border-top:1px solid var(--dsw-alias-border-l1,#333);background:var(--dsw-alias-bg-layer-2,#1c1c21);flex:none;font-size:11px}",
      ".uq-footer-info{color:var(--dsw-alias-label-tertiary,#8a8a93);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".uq-footer-actions{display:inline-flex;gap:6px;flex:none}",
      ".uq-footer .uq-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l1,#3a3a41);border-radius:6px;font-size:11px}",
      ".uq-footer .uq-btn:hover{background:var(--dsw-alias-bg-layer-3,#26262c)}",
      // —— 血条（全部走主题变量，换主题自动跟随）——
      ".uq-hp-frame{position:relative;display:block;width:100%;min-width:0;padding:2px;box-sizing:border-box;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,#4a4a53);background:var(--dsw-alias-bg-layer-1,#191920);box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
      ".uq-hp-frame[data-capped=1]{border-color:rgba(176,82,82,.75);box-shadow:inset 0 1px 0 rgba(176,82,82,.25),0 0 0 1px rgba(176,82,82,.18)}",
      ".uq-hp-track{position:relative;height:100%;border-radius:3px;overflow:hidden;background:var(--dsw-alias-bg-layer-3,#2a2a31)}",
      ".uq-hp-fill{display:block;height:100%;border-radius:3px;background:linear-gradient(180deg,var(--hp-b,#6b9a75),var(--hp-a,#4a7a58));box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 -1px 0 rgba(0,0,0,.18);transition:width .35s cubic-bezier(.25,.8,.3,1),background .3s}",
      ".uq-hp-tick{position:absolute;top:2px;bottom:2px;width:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.45));opacity:.55;pointer-events:none}",
      // —— 窗口控制按钮（最小化 / 最大化 / 关闭）——
      ".uq-winbtn{width:24px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;border:1px solid transparent;background:none;color:var(--dsw-alias-label-secondary,#b3b3bd);font-size:12px;line-height:1;cursor:pointer;transition:background .15s,color .15s,border-color .15s}",
      ".uq-winbtn:hover{background:var(--dsw-alias-bg-layer-3,#26262c);color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-border-l1,#3a3a41)}",
      ".uq-winbtn-close:hover{background:rgba(176,82,82,.22);color:#e08a8a;border-color:rgba(176,82,82,.5)}",
      ".uq-anchor{pointer-events:none}.uq-anchor>*{pointer-events:auto}",
      // —— 纯 CSS 即时悬停气泡（data-tip）：零 JS、不漂移、不抖动、即时 ——
      ".uq-tip-anchor{position:relative;cursor:help;transition:filter .12s ease,opacity .12s ease}",
      // 对齐 DSH 本体：悬停时元素轻微变暗，给出可交互反馈
      ".uq-tip-anchor:hover{filter:brightness(.88)}",

      // 气泡改由 JS 单例渲染（见 ensureTipLayer），CSS 不再生成 ::after
      // —— 主题化悬停气泡（接管 title，跟随 DSH 主题）——
      ".uq-tip{position:fixed;z-index:2147483600;pointer-events:none;max-width:360px;padding:5px 9px;border-radius:6px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-3,#2b2b31);color:var(--dsw-alias-label-primary,#e6e6e6);border:1px solid var(--dsw-alias-border-l2,#4a4a53);box-shadow:0 8px 24px rgba(0,0,0,.45)}",
      ".uq-hp-label{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".uq-hp-label-left{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".uq-hp-label-right{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}",
      ".uq-hp-pct{font-weight:600;color:var(--dsw-alias-label-secondary,#b3b3bd)}",
      ".uq-hp-pct[data-warn=1]{color:var(--dsw-alias-state-warn-primary,#bfa557)}",
      ".uq-hp-cap{font-size:10px;color:#b05252;border:1px solid rgba(176,82,82,.55);border-radius:4px;padding:0 4px}",
      // —— 渠道分组 + 模型行（额度窗口 / 积分账单共用）——
      ".uq-qgroup{margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,#26262c);animation:uqFade .2s ease-out}",
      ".uq-qgroup:last-child{border-bottom:0}",
      ".uq-qhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:4px 0 5px}",
      ".uq-qname{font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".uq-qbal{font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary,#b3b3bd)}",
      ".uq-chip[data-danger=1]{border-color:rgba(176,82,82,.6);color:#b05252;background:rgba(176,82,82,.1)}",
      // 模型行
      ".uq-mrow2{padding:5px 0 6px 12px;border-left:2px solid transparent;transition:background .12s}",
      ".uq-mrow2:hover{background:var(--dsw-alias-bg-layer-3,#22222a)}",
      ".uq-mrow2[data-status=warn]{border-left-color:#bfa557}",
      ".uq-mrow2[data-status=danger]{border-left-color:#b05252;background:rgba(176,82,82,.05)}",
      ".uq-mrow2-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px}",
      ".uq-mrow2-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;min-width:0}",
      ".uq-mrow2-val{font-variant-numeric:tabular-nums;white-space:nowrap;display:inline-flex;align-items:baseline;gap:3px}",
      ".uq-mrow2-bar{display:flex;align-items:center;gap:8px;margin-top:4px}",
      ".uq-mrow2-lim{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93);font-variant-numeric:tabular-nums;white-space:nowrap;display:inline-flex;align-items:center;gap:3px}",
      ".uq-mrow2-set{border:0;background:none;color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:10px;cursor:pointer;padding:2px 0;text-decoration:underline dotted;flex:none}",
      ".uq-mrow2-set:hover{color:#8fa4ff}",
      ".uq-mrow2-edit{display:flex;gap:6px;margin-top:5px;animation:uqFade .15s}",
      ".uq-mrow2-edit .uq-input{flex:1;min-width:0}",
      // 进度条（额度）
      ".uq-mbar{flex:1;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-3,#2a2a31);overflow:hidden;min-width:40px}",
      ".uq-mbar>i{display:block;height:100%;border-radius:3px;transition:width .35s cubic-bezier(.25,.8,.3,1)}",
      ".uq-bar-ok>i{background:linear-gradient(90deg,#3b82f6,#4d6bfe)}",
      ".uq-bar-warn>i{background:linear-gradient(90deg,#bfa557,#f0b44a)}",
      ".uq-bar-danger>i{background:linear-gradient(90deg,#b05252,#f07070)}",
      // 占比条（积分）
      ".uq-cbar{height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-3,#2a2a31);overflow:hidden;margin:4px 0 2px}",
      ".uq-cbar>i{display:block;height:100%;border-radius:3px;opacity:.85;transition:width .35s cubic-bezier(.25,.8,.3,1)}",
      ".uq-tabs{display:flex;gap:4px;padding:8px 16px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#333);flex-wrap:wrap}",
      ".uq-tab{padding:6px 12px;border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;background:none;color:var(--dsw-alias-label-secondary,#b3b3bd);font-size:12px;cursor:pointer}",
      ".uq-tab[data-on=1]{background:rgba(77,107,254,.14);border-color:rgba(77,107,254,.55);color:#8fa4ff;font-weight:600;box-shadow:inset 0 -2px 0 #4d6bfe}",
      ".uq-tab:hover{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#24242c)}",
      ".uq-body{padding:12px 16px 16px;overflow:auto;flex:1 1 auto;min-height:0}",
      ".uq-table{width:100%;border-collapse:collapse;font-size:12px}",
      ".uq-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,#8a8a93);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#333);position:sticky;top:0;background:var(--dsw-alias-bg-base,#151519)}",
      ".uq-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a30);font-variant-numeric:tabular-nums}",
      ".uq-table tr:hover td{background:var(--dsw-alias-bg-layer-2,#1c1c21)}",
      ".uq-table td.num,.uq-table th.num{text-align:right}",
      ".uq-chip{display:inline-block;padding:1px 6px;border-radius:999px;font-size:10px;background:var(--dsw-alias-bg-layer-3,#2b2b31);color:var(--dsw-alias-label-secondary,#b3b3bd);margin-left:4px}",
      ".uq-chip[data-plan=1]{background:rgba(77,107,254,.16);color:var(--dsw-alias-brand-primary,#7d94ff)}",
      ".uq-spark{display:flex;align-items:flex-end;gap:2px;height:70px;margin:8px 0 12px}",
      ".uq-spark i{flex:1;min-width:2px;background:var(--dsw-alias-brand-primary,#4d6bfe);border-radius:1px 1px 0 0;opacity:.85}",
      ".uq-spark i[data-plan=1]{background:var(--dsw-alias-label-tertiary,#6b6b74)}",
      ".uq-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:12px}",
      ".uq-clickable{cursor:pointer}",
      ".uq-clickable:hover td{background:var(--dsw-alias-bg-layer-3,#24242c)}",
      ".uq-caret{display:inline-block;width:10px;font-size:9px;color:var(--dsw-alias-label-tertiary,#8a8a93);transition:transform .15s}",
      ".uq-caret[data-open=1]{color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".uq-subrows{padding:6px 8px 8px 26px;display:flex;flex-direction:column;gap:3px;animation:uqRise .16s ease-out}",
      ".uq-subrow{display:grid;grid-template-columns:1fr auto auto auto;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary,#b3b3bd);align-items:center}",
      ".uq-subrow-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px}",
      ".uq-subrow-num{font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".uq-credit{color:var(--dsw-alias-state-business-primary,#7d94ff)}",
      ".uq-filterbar{display:flex;align-items:center;gap:8px;padding:6px 0 2px;animation:uqFade .2s ease-out}",
      ".uq-legend{display:flex;flex-wrap:wrap;gap:4px 12px;padding:6px 0 2px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      // 堆叠柱：外层纵向 flex，内部各段自下而上
      ".uq-bar-stack{flex:1 1 0;min-width:3px;display:flex;flex-direction:column-reverse;justify-content:flex-start;border-radius:3px 3px 0 0;overflow:hidden;cursor:pointer;transition:opacity .15s,filter .15s;background:var(--dsw-alias-bg-layer-3,#26262c)}",
      ".uq-bar-stack:hover{opacity:.92;filter:brightness(1.12)}",
      ".uq-bar-stack[data-peak=1]{box-shadow:0 0 0 1px rgba(255,255,255,.22),0 0 8px rgba(77,107,254,.35)}",
      ".uq-bar-stack[data-empty=1]{opacity:.55}",
      ".uq-seg-part{display:block;width:100%;min-height:1px;transition:flex-grow .3s ease}",
      ".uq-seg-part:hover{filter:brightness(1.25)}",
      ".uq-bar-stack{animation:uqGrow .42s cubic-bezier(.22,1,.36,1) both;transform-origin:bottom}",
      ".uq-bar-stack:nth-child(n+8){animation-delay:.03s}",
      ".uq-bar-stack:nth-child(n+15){animation-delay:.06s}",
      ".uq-help{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#4a4a53);color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:9px;line-height:1;margin-left:3px;cursor:help;flex:none;transition:all .15s;vertical-align:middle}",
      ".uq-help:hover{border-color:#4d6bfe;color:#8fa4ff;background:rgba(77,107,254,.12)}",
      ".uq-help:focus-visible{outline:2px solid #4d6bfe;outline-offset:1px}",
      ".uq-legend-item{display:inline-flex;align-items:center;gap:4px}",
      ".uq-legend-item>i{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}",
      ".uq-filterbar .uq-btn{font-size:11px}",
      ".uq-set{display:flex;flex-direction:column;gap:14px}",
      ".uq-set-group{border:1px solid var(--dsw-alias-border-l1,#333);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2,#1c1c21)}",
      ".uq-set-group>h4{margin:0 0 10px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b3b3bd)}",
      ".uq-field{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0}",
      ".uq-field>label{font-size:12px;color:var(--dsw-alias-label-primary,#e6e6e6);min-width:0}",
      ".uq-field>label small{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93);margin-top:2px}",
      ".uq-input,.uq-select{background:var(--dsw-alias-bg-base,#151519);color:var(--dsw-alias-label-primary,#e6e6e6);border:1px solid var(--dsw-alias-border-l1,#3a3a41);border-radius:6px;padding:4px 8px;font-size:12px;min-width:88px;max-width:180px}",
      ".uq-switch{position:relative;width:34px;height:18px;border-radius:9px;background:var(--dsw-alias-bg-layer-3,#2b2b31);border:1px solid var(--dsw-alias-border-l1,#3a3a41);cursor:pointer;flex:none}",
      ".uq-switch[data-on=1]{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent}",
      ".uq-switch i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s}",
      ".uq-switch[data-on=1] i{left:18px}",
      ".uq-save{color:var(--dsw-alias-state-success-primary,#34c77b);font-size:11px}",
      ".uq-bar2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0}",
      ".uq-trend-wrap{padding:8px 0 2px}",".uq-trend{display:flex;align-items:flex-end;gap:2px;height:86px;padding:0}",".uq-trend-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93);margin-top:4px}",
      
      
      ".uq-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#3a3a41);font-size:11px;color:var(--dsw-alias-label-secondary,#b3b3bd)}",
      ".uq-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11px}",
      ".uq-kv b{font-variant-numeric:tabular-nums;font-weight:500;text-align:right}",
      ".uq-call{border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a30);padding:6px 0;font-size:11px}",
      ".uq-call>summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#b3b3bd);display:flex;gap:8px;justify-content:space-between}",
      ".uq-call[open]>summary{color:var(--dsw-alias-label-primary,#e6e6e6)}",
      ".uq-loading{padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:12px}",
      // ——— v2.2 视觉/交互层 ———
      "@keyframes uqFade{from{opacity:0}to{opacity:1}}",
      "@keyframes uqPop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}",
      "@keyframes uqRise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
      "@keyframes uqSpin{to{transform:rotate(360deg)}}",
      "@keyframes uqShimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}",
      "@keyframes uqGrow{from{transform:scaleY(.02);transform-origin:bottom}to{transform:scaleY(1);transform-origin:bottom}}",
      "@media (prefers-reduced-motion: reduce){*{animation-duration:.001ms !important;transition-duration:.001ms !important}}",
      // 趋势柱：进入时从底部生长（社区图表库默认入场动画）
      
      
      
      
      
      // 表格行 hover 提亮 + 键盘焦点环
      ".uq-clickable:focus-visible{outline:2px solid #4d6bfe;outline-offset:-2px}",
      ".uq-btn:focus-visible,.uq-tab:focus-visible,.uq-seg2>button:focus-visible{outline:2px solid #4d6bfe;outline-offset:1px}",
      // 数值切换时的淡入，避免硬跳
      ".uq-hero-value,.uq-stats .v{animation:uqFade .28s ease-out}",
      
      ".uq-pop{animation:uqPop .18s cubic-bezier(.2,.8,.2,1);width:420px}",
      ".uq-sheet{animation:uqFade .16s ease-out;backdrop-filter:blur(2px)}",
      ".uq-dlg{animation:uqPop .2s cubic-bezier(.2,.8,.2,1)}",
      ".uq-bar{transition:background .15s,border-color .15s,transform .12s}",
      ".uq-bar:active{transform:scale(.99)}",
      ".uq-btn{transition:background .15s,color .15s,transform .12s}",
      ".uq-btn:active{transform:scale(.94)}",
      ".uq-tab{transition:background .15s,color .15s,border-color .15s}",
      ".uq-fill{transition:width .45s cubic-bezier(.25,.8,.3,1)}",
      ".uq-row{transition:background .12s}",
      ".uq-table tbody tr{transition:background .12s}",
      ".uq-card{transition:border-color .15s,background .15s}",
      ".uq-card:hover{border-color:var(--dsw-alias-border-l2,#4a4a53)}",
      ".uq-spin{animation:uqSpin .9s linear infinite;display:inline-block}",
      // 顶部概览条（一眼看全）
      ".uq-hero{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:4px}",
      ".uq-hero-cell{border:1px solid var(--dsw-alias-border-l1,#333);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#1c1c21);min-width:0;transition:border-color .15s}",
      ".uq-hero-cell:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".uq-hero-label{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93);display:flex;align-items:center;gap:4px}",
      ".uq-hero-value{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px;letter-spacing:-.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".uq-hero-sub{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93);margin-top:1px}",
      // 分段切换（比裸按钮清楚）
      ".uq-seg2{display:inline-flex;position:relative;padding:3px;gap:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-3,#26262c);border:1px solid var(--dsw-alias-border-l1,#3a3a41);box-shadow:inset 0 1px 2px rgba(0,0,0,.18)}",
      ".uq-seg2>button{position:relative;z-index:1;border:0;background:none;color:#9aa0aa;font-size:11px;padding:4px 11px;border-radius:7px;cursor:pointer;transition:color .18s ease,background .18s ease,box-shadow .18s ease;white-space:nowrap}",
      ".uq-seg2>button:hover{color:#d8dbe2}",
      ".uq-seg2>button[data-on=1]{background:#4d6bfe;color:#fff;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.18)}",
      ".uq-seg2>button[data-on=0]:hover{background:var(--dsw-alias-bg-layer-2,#2a2a32);color:var(--dsw-alias-label-primary,#e6e6e6)}",
      // 工具栏分组
      ".uq-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0 6px}",
      ".uq-toolbar-sp{flex:1}",
      ".uq-lab{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93);text-transform:uppercase;letter-spacing:.04em}",
      // 统计小卡
      ".uq-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:6px 0 10px}",
      ".uq-stats>div{border:1px solid var(--dsw-alias-border-l1,#333);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2,#1c1c21)}",
      ".uq-stats .k{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".uq-stats .v{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:1px}",
      // 骨架屏
      ".uq-skel{height:12px;border-radius:4px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-3,#242429) 25%,var(--dsw-alias-bg-layer-2,#2e2e36) 37%,var(--dsw-alias-bg-layer-3,#242429) 63%);background-size:200% 100%;animation:uqShimmer 1.3s ease-in-out infinite;margin:6px 0}",
      // 渠道列表更紧凑、可点开
      ".uq-ch{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#26262c);transition:background .12s}",
      ".uq-ch:last-child{border-bottom:0}",
      ".uq-ch:hover{background:var(--dsw-alias-bg-layer-3,#22222a)}",
      ".uq-ch-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      ".uq-ch-val{font-variant-numeric:tabular-nums;font-weight:600;font-size:12px;white-space:nowrap}",
      ".uq-ch-bar{width:52px;flex:none}",
      "@media (max-width:520px){.uq-hero{grid-template-columns:1fr 1fr}.uq-stats{grid-template-columns:1fr 1fr}}",
      ".uq-entry{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#3a3a41);background:var(--dsw-alias-bg-layer-2,#1c1c21);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:18px;cursor:pointer}",
      ".uq-entry:hover{background:var(--dsw-alias-bg-layer-3,#24242a);border-color:var(--dsw-alias-border-l2,#4a4a53)}"
    ].join("");
    /** CSS 版本戳：升级后必须整体替换样式表，否则旧 style 会挡住新规则（曾导致选中态不生效）。 */
    const CSS_REV = "uq-7.25.4";
    /** 与宿主 BUILD 比对；不一致说明宿主没重启。 */
    const CLIENT_VERSION = "7.25.4";
    function ensureCss() {
      try {
        const marked = document.querySelectorAll("style[data-plugin-css]");
        let current = null;
        for (let k = 0; k < marked.length; k += 1) {
          const v = marked[k].getAttribute("data-plugin-css") || "";
          if (v === CSS_REV) { current = marked[k]; continue; }
          if (v.indexOf("uq") === 0) { try { marked[k].remove(); } catch (e) {} }
        }
        if (current !== null) return;
        const s = document.createElement("style");
        s.setAttribute("data-plugin-css", CSS_REV);
        s.textContent = css;
        document.head.appendChild(s);
      } catch (e) { /* nothing sensible to do */ }
    }
    //#endregion
    /**
     * 渠道品牌色。参考社区对各家的惯用配色（DeepSeek 蓝、Claude 橙、OpenAI 绿…），
     * 只用于「区分」，不声称是官方色值。
     */
    const BRAND_COLOR = {
      "deepseek-account": "#4d6bfe", "deepseek-official": "#3b82f6", deepseek: "#4d6bfe",
      anthropic: "#d97757", claude: "#d97757",
      openai: "#10a37f", codex: "#10a37f",
      google: "#4285f4", gemini: "#8e75f0",
      qodercn: "#2f9e8f", qoder: "#2f9e8f",
      trae: "#e8543f", codearts: "#c0392b", huawei: "#c0392b",
      buddy: "#0aa1dd", workbuddy: "#0e7490", "workbuddy-global": "#0e7490",
      zcode: "#7b61ff", cline: "#d4a017", minimax: "#e2483d",
      opencode: "#6b7280", raccoon: "#f59e0b", loomy: "#ec4899",
      officeace: "#0891b2", accio: "#a855f7", astudio: "#f97316",
      modelscope: "#6366f1", qiniu: "#00b5e2", codely: "#14b8a6",
      monkeycode: "#8b5cf6", baizhi: "#f43f5e", doubao: "#3b82f6",
      marvis: "#06b6d4", magicrew: "#d946ef", aggregate: "#94a3b8",
    };
    const FALLBACK_COLORS = ["#4d6bfe", "#d97757", "#10a37f", "#8e75f0", "#e8543f", "#2f9e8f", "#d4a017", "#ec4899"];
    function brandColor(provider) {
      const key = String(provider || "").toLowerCase();
      if (BRAND_COLOR[key]) return BRAND_COLOR[key];
      // 未收录的渠道：按名字稳定散列到一组可区分色，保证同一渠道每次同色
      let h = 0;
      for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 997;
      return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
    }
    /**
     * 指标释义（悬停提示的唯一文案源）。集中维护，避免各处措辞不一致。
     * 统一用「是什么 + 怎么算 + 能用来判断什么」三段式。
     */
    const GLOSSARY = {
      zh: {
        officialBalance: "DeepSeek 官方账户余额（充值 + 赠金）。来源：设置→账号与余额的登录态；没登录时回退到 API Key 查询。",
        fx: "汇率：1 美元 = 多少显示币种。每天从欧洲央行参考价自动更新一次；取不到时沿用上次的值。",
        todayPaid: "今日实付：真正从钱包扣掉的钱（不含套餐额度折算）。数据来自本插件自己的记账。",
        todayEquiv: "今日等值：按官方目录价折算的\"如果按量付费要多少钱\"。套餐渠道实际没扣钱，所以它只是参考值。",
        channelsOk: "可用渠道数 / 已接入渠道数。可用 = 成功读到余额；不可用通常是未登录或上游拒绝。",
        tokens: "token 总量 = 未缓存输入 + 输出 + 缓存读取 + 缓存写入。缓存读取的价格通常只有输入的 1/10。",
        share: "该行 token 占当前筛选范围总量的比例。",
        paid: "实付：真金白银扣款。套餐/免费渠道是 0。",
        equiv: "等值：按目录价折算的参考金额。套餐渠道实际没扣钱。",
        calls: "调用次数：每次模型请求记 1 次（一次对话可能有多次调用）。",
        credit: "积分当量 = token × 该模型倍率。很多白嫖渠道按积分扣费，不同模型消耗倍率不同（如 ×3.0 表示消耗 3 倍）。",
        factor: "倍率：该模型每消耗 1 token 记多少积分。来源是渠道下发的模型展示名，每 20 分钟随上游更新。",
        unknownFactor: "该渠道没有下发倍率，无法计入积分当量。它们被单独计数，不混进合计（否则会低估）。",
        hitRate: "缓存命中率 = 缓存读取 ÷ 计费输入（未缓存输入 + 缓存读取 + 缓存写入）。越高越省钱。",
        trend: "逐日用量趋势。柱高 = 该日金额；柱色 = 该日用量最大的渠道。悬停看构成。",
        composition: "Token 构成：未缓存输入 / 缓存读取 / 缓存写入 / 输出 各自占比。",
        basisApi: "只统计真金白银的扣款，套餐渠道记 0。",
        basisTotal: "实付 + 等值，反映\"如果全部按量付费\"的总成本。",
        basisPlan: "只统计套餐额度折算的等值部分，看订阅额度用掉了多少。",
        subagent: "子代理：主模型派生出的辅助会话。合并统计时它们的用量也计入。",
        window: "统计时间范围：近 7 / 30 / 90 天。",
      },
      en: {
        officialBalance: "DeepSeek official balance (top-up + bonus). Source: account sign-in; falls back to API key.",
        fx: "Exchange rate: 1 USD in display currency. Refreshed daily from ECB reference rates.",
        todayPaid: "Today's real spend (wallet deducted). Recorded by this plugin itself.",
        todayEquiv: "Today's equivalent cost at list price. Plan channels are not actually charged.",
        channelsOk: "Channels with readable balance / total connected channels.",
        tokens: "Total tokens = uncached input + output + cache read + cache write.",
        share: "This row's token share within the current filter.",
        paid: "Real money charged. Plan/free channels are 0.",
        equiv: "List-price equivalent. Plan channels are not actually charged.",
        calls: "Number of model requests (one conversation may make several).",
        credit: "Credit equivalent = tokens x model factor. Many channels bill in credits with per-model multipliers.",
        factor: "Factor: credits charged per token for this model. Comes from the channel's model display name, refreshed with upstream.",
        unknownFactor: "This channel does not publish factors, so it cannot be counted into credit totals; it is reported separately.",
        hitRate: "Cache hit rate = cache read / billed input. Higher is cheaper.",
        trend: "Daily usage. Bar height = amount; bar color = dominant channel that day.",
        composition: "Token mix: uncached input / cache read / cache write / output.",
        basisApi: "Real charges only; plan channels count as 0.",
        basisTotal: "Paid + equivalent: cost if everything were metered.",
        basisPlan: "Plan-equivalent portion only.",
        subagent: "Subagents are auxiliary sessions spawned by the main model.",
        window: "Time range: last 7 / 30 / 90 days.",
      },
    };
    /** 带释义的小问号；点击/悬停显示说明。用 title 属性最稳（不依赖宿主组件）。 */
    /** 释义标记「?」：用 DSH 原生 Tooltip（跟随宿主主题），不用浏览器 title。 */
    function Help({ k, L }) {
      const text = gloss(k, L);
      if (!text) return null;
      // 不设 tabIndex：否则会被 Tab/点击聚焦出蓝环（截图里就是这个）
      return tip(text, h("span", { className: "uq-help" }, "?"));
    }
    /** 把 "标签 + 释义" 组合成一个可悬停的表头单元。 */
    function withHelp(node, k, L) {
      const text = gloss(k, L);
      if (!text) return node;
      return h(react.Fragment, null, node, Help({ k: k, L: L }));
    }
    function gloss(key, L) {
      const pack = GLOSSARY[L === "zh" ? "zh" : "en"] || GLOSSARY.zh;
      return pack[key] || "";
    }
    //#region i18n
    const dict = {
      zh: { title: "额度中心", official: "DeepSeek 官方", channels: "模型接入渠道", cost: "费用与用量", whale: "小鲸鱼观测", today: "今日", month30: "近 30 天", tokens: "token", refresh: "刷新", spent: "实付", equiv: "等值", observed: "观测消费", lastTurn: "最近一轮", noData: "暂无数据", packages: "额度包", expires: "到期", usageNote: "白嫖渠道费用为等值参考（未实际扣费）" },
      en: { title: "Quota Center", official: "DeepSeek Official", channels: "Model Channels", cost: "Cost & Usage", whale: "Whale Observations", today: "Today", month30: "30 days", tokens: "tokens", refresh: "Refresh", spent: "Paid", equiv: "equivalent", observed: "observed spend", lastTurn: "last turn", noData: "no data", packages: "packages", expires: "expires", usageNote: "Channel costs are equivalent-price references (nothing was billed)." }
    };
    function locale() {
      try {
        const n = (document.documentElement.lang || (navigator.language || "zh")).toLowerCase();
        return n.indexOf("zh") === 0 ? "zh" : "en";
      } catch (e) { return "zh"; }
    }
    //#endregion
    //#region formatting
    function kilo(n) {
      const v = Number(n) || 0;
      if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2).replace(/0+$/, "").replace(/[.]$/, "") + "B";
      if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2).replace(/0+$/, "").replace(/[.]$/, "") + "M";
      if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/[.]0$/, "") + "K";
      return String(Math.round(v));
    }
    function money(n, cur) {
      const v = Number(n) || 0;
      const sym = cur === "CNY" ? "¥" : cur === "EUR" ? "€" : "$";
      const abs = Math.abs(v);
      // 「小数位数」设置生效：读取共享配置（设置页/其它组件同步），全局货币显示统一遵守。
      const g = getCfg && getCfg();
      const dec = (g && Number.isInteger(g.decimals)) ? Math.max(0, Math.min(8, g.decimals)) : 2;
      // 完全按设置的小数位数显示（改动立即可见）
      const digits = dec;
      if (abs >= 1000) return sym + v.toLocaleString(undefined, { maximumFractionDigits: dec });
      return sym + v.toFixed(digits);
    }
    function dayLabel(d, L) { return d.slice(5).replace("-", "/"); }
    function fmtDate(ms) { try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }); } catch (e) { return ""; } }
    const CHANNEL_LABELS = {
      buddy: "CodeBuddy", workbuddy: "WorkBuddy", "workbuddy-global": "WorkBuddy 国际",
      qodercn: "Qoder 中国版", qoder: "Qoder 国际", trae: "TRAE", "trae-global": "TRAE 国际",
      zcode: "ZCode", codearts: "CodeArts", opencode: "OpenCode", cline: "Cline",
      minimax: "MiniMax", minimaxintl: "MiniMax 国际", raccoon: "小浣熊", loomy: "Loomy",
      lobsterai: "Lobster", gemini: "Gemini", officeace: "OfficeAce", accio: "Accio",
      astudio: "AStudio", autoclaw: "AutoClaw", modelscope: "魔搭", qiniu: "七牛",
      codely: "Codely", monkeycode: "MonkeyCode", baizhi: "百智", doubao: "豆包",
      marvis: "Marvis", magicrew: "Magicrew", aggregate: "聚合",
      "deepseek-account": "DeepSeek 官方（账号）", "deepseek-official": "DeepSeek 官方（API）", deepseek: "DeepSeek"
    };
    function channelLabel(p, L) {
      const known = CHANNEL_LABELS[p];
      if (known) return known;
      return p ? p.charAt(0).toUpperCase() + p.slice(1) : "—";
    }
    //#endregion
    let toPortal = null;
    try { const rd = require("react-dom"); toPortal = typeof rd.createPortal === "function" ? rd.createPortal.bind(rd) : null; } catch (e) { toPortal = null; }
    function mountPop(node) { if (toPortal === null) return node; try { return toPortal(node, document.body); } catch (e) { return node; } }
    //#region data
    const CORE_URL = "/api/unified-quota/core";
    const CODEARTS_URL = "/api/codearts/status";
    const WHALE_BAL_URL = "/dsh-whale/balance.json";
    const WORKBUDDY_URL = "/plugins/dsh-workbuddy-connect/status";
    const T_STALE = 60000;
    async function fetchJson(url) {
      const res = await fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (!res.ok) { throw new Error(String(res.status)); }
      return res.json();
    }
    function useCore() {
      const [data, setData] = react.useState(null);
      const [extra, setExtra] = react.useState({ codearts: null, workbuddy: null, whaleLive: null });
      const [error, setError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const loaded = react.useRef(0);
      const load = react.useCallback(async function (force) {
        if (loaded.current > 0 && !force && Date.now() - loaded.current < T_STALE) return;
        setBusy(true);
        try {
          const core = await fetchJson(CORE_URL + (force ? "?refresh=1" : ""));
          loaded.current = Date.now();
          setError(null);
          setData(core);
          // enrichments from sibling plugins: each best-effort, missing plugin = missing row
          const ca = await fetchJson(CODEARTS_URL).catch(function () { return null; });
          const wb = await fetchJson(WORKBUDDY_URL).catch(function () { return null; });
          const wl = await fetchJson(WHALE_BAL_URL).catch(function () { return null; });
          setExtra({ codearts: ca, workbuddy: wb, whaleLive: wl });
        } catch (e) {
          setError(e && e.message ? String(e.message) : String(e));
        } finally {
          setBusy(false);
        }
      }, []);
      react.useEffect(function () { void load(false); }, [load]);
      // 币种/汇率变更后必须重新拉取 /core（后端按 currency 换算，不重拉会显示旧币种数值）
      const cfgV = useCfgVersion();
      const curNow = (getCfg && getCfg() && getCfg().currency) || "CNY";
      const firstRef = react.useRef(true);
      react.useEffect(function () {
        if (firstRef.current) { firstRef.current = false; return; }
        loaded.current = 0;          // 清掉 60 秒节流
        void load(true);             // force
      }, [curNow]);
      return { data: data, extra: extra, error: error, busy: busy, load: load };
    }
    //#endregion
    //#region atoms
    function Dot(ok) { return h("span", { className: "uq-dot", "data-ok": ok === true ? "1" : ok === false ? "0" : "x" }); }
    function Head(label, right) {
      return h("div", { className: "uq-h" }, h("span", null, label), right || null);
    }
    function Bar(frac, warn, danger) {
      const f = Math.max(0, Math.min(1, Number(frac) || 0));
      return h("div", { className: "uq-track" }, h("div", {
        className: "uq-fill", "data-warn": warn ? "1" : "0", "data-danger": danger ? "1" : "0",
        style: { width: (f * 100).toFixed(1) + "%" }
      }));
    }
    function creditTier(remaining, total) {
      if (!(total > 0) || !(remaining >= 0)) return null;
      const r = remaining / total;
      return { frac: r, warn: r <= 0.25, danger: r <= 0.08 };
    }
    function Unit({ L, value, unit, dim }) {
      return h("span", { className: "uq-v" + (dim ? " uq-dim" : "") }, value, " ", h("span", { className: "uq-sub" }, unit));
    }
    //#endregion
    //#region sections
    function OfficialSection({ core, L }) {
      useCfgVersion();  // 币种/小数位改动后重渲染
      const __c1 = getCfg && getCfg();
      const cur = (core.money && core.money.currency) || (__c1 && __c1.currency) || "CNY";
      const live = core.official;
      const snap = core.ledger && core.ledger.official;
      const wallets = live && Array.isArray(live.wallets) ? live.wallets : null;
      const totalCny = wallets && wallets.length
        ? wallets.reduce(function (s, w) { return s + (Number(w.total) || 0); }, 0)
        : (snap ? Number(snap.total) : null);
      const src = live ? (live.source === "account" ? (L === "zh" ? "账号登录态" : "account sign-in") : "API key") : (snap ? (L === "zh" ? "账本快照" : "ledger snapshot") : null);
      if (totalCny === null) return null;
      const todayCost = core.ledger ? core.ledger.today.cost : 0;
      return h("div", { className: "uq-card" },
        h("div", { className: "uq-row" },
          h("span", { className: "uq-l" }, Dot(Boolean(live)), " ", (L === "zh" ? "余额" : "Balance")),
          tip((L === "zh" ? "来源：" : "source: ") + src + (wallets && wallets.length > 1 ? "" : ""),
            h("span", { className: "uq-big" }, money(totalCny, cur)))),
        wallets && wallets.length ? h("div", { className: "uq-models" }, wallets.map(function (w) {
          return h("div", { className: "uq-mrow", key: w.currency },
            h("span", null, w.currency, " ", h("span", { className: "uq-dim" }, (L === "zh" ? "充值/赠" : "paid/bonus"))),
            h("span", null, w.topped || "0.00", " / ", w.granted || "0.00"));
        })) : null,
        h("div", { className: "uq-row" },
          h("span", { className: "uq-l uq-dim" }, L === "zh" ? "今日费用" : "today cost"),
          h("span", { className: "uq-v" }, money(core.ledger ? core.ledger.today.cost : 0, core.ledger && core.ledger.currency))));
    }
    function ChannelsSection({ core, extra, L }) {
      const ch = core.channels || {};
      const rows = ch.credits || (ch.providers || []).map(function (p) { return { provider: p.provider, accounts: p.accounts, credits: { total: null, packages: [], error: "" }, error: ch.error || "" }; });
      if (!rows.length) return null;
      const ca = extra.codearts;
      const caTokens = ca && ca.usage && ca.usage.today ? (Number(ca.usage.today.totalTokens) || 0) : 0;
      return h("div", null,
        Head(L === "zh" ? "模型接入渠道（白嫖）" : "Model channels", h("span", { className: "uq-sub" }, rows.length + (ca ? 1 : 0))),
        rows.map(function (r) {
          const c = r.credits || {};
          const total = Number.isFinite(c.total) ? c.total : null;
          const unit = c.unit || (total === null ? "" : "");
          const pkgs = Array.isArray(c.packages) ? c.packages : [];
          const sumTotal = pkgs.reduce(function (s, p) { return s + (Number(p.total) || 0); }, 0);
          const sumLeft = pkgs.reduce(function (s, p) { return s + (Number(p.remaining) || 0); }, 0);
          const tier = total !== null && sumTotal > 0 ? creditTier(sumLeft, sumTotal) : null;
          const name = channelLabel(r.provider, L);
          const tipText = pkgs.length
            ? pkgs.map(function (p) { return p.name + ": " + (p.remaining === null ? "?" : kilo(p.remaining)) + "/" + (p.total === null ? "?" : kilo(p.total)) + (p.unit || "") + (p.expiredTime ? (" (" + p.expiredTime + ")") : ""); }).join(" · ")
            : (r.error || c.error || "");
          return h("div", { key: r.provider, className: "uq-row", style: { display: "block", padding: "5px 0" } },
            tip(tipText, h("div", { style: { display: "flex", justifyContent: "space-between", gap: 10 } },
              h("span", { className: "uq-l" }, Dot(total !== null), " ", name),
              total === null
                ? h("span", { className: "uq-v uq-dim" }, r.error || c.error || (L === "zh" ? "未取到" : "n/a"))
                : h("span", { className: "uq-v" }, kilo(total), " ", h("span", { className: "uq-sub" }, unit || (L === "zh" ? "积分" : unit))))),
            tier ? Bar(tier.frac, tier.warn, tier.danger) : null);
        }),
        ca ? h("div", { className: "uq-row", style: { display: "block", padding: "5px 0" } },
          tip(L === "zh" ? "来自 dsh-codearts 自身状态路由" : "from dsh-codearts status", h("div", { style: { display: "flex", justifyContent: "space-between", gap: 10 } },
            h("span", { className: "uq-l" }, Dot(ca.status === "signed-in" || ca.status === "ready"), " ", "CodeArts"),
            h("span", { className: "uq-v" }, ca.status === "signed-out"
              ? h("span", { className: "uq-dim" }, L === "zh" ? "未登录" : "signed out")
              : h("span", null, kilo(caTokens), " ", h("span", { className: "uq-sub" }, (L === "zh" ? "今日 token" : "tok today"))))))
        ) : null,
        h("div", { className: "uq-sub" }, L === "zh" ? dict.zh.usageNote : dict.en.usageNote));
    }
    function UsageSection({ core, extra, L }) {
      const lg = core.ledger;
      if (!lg) return null;
      const cur = lg.currency || "USD";
      const rows = lg.providers30 || [];
      const top = rows.slice(0, 6);
      const maxTok = top.reduce(function (m, r) { return Math.max(m, r.tokens); }, 1);
      const live = extra.codearts;
      const wb = extra.workbuddy;
      return h("div", null,
        Head(L === "zh" ? "近 30 天用量（按渠道）" : "30-day usage by channel"),
        h("div", { className: "uq-grid", style: { marginBottom: 8 } },
          h("div", null, h("div", { className: "uq-sub" }, L === "zh" ? "今日实付" : "today paid"), h("div", { className: "uq-big" }, money(lg.today.apiCost, cur))),
          h("div", null, h("div", { className: "uq-sub" }, L === "zh" ? "30 天实付" : "30d paid"), h("div", { className: "uq-big" }, money(lg.month.apiCost, cur))),
          h("div", null, h("div", { className: "uq-sub" }, L === "zh" ? "30 天 token" : "30d tokens"), h("div", { className: "uq-big" }, kilo(lg.month.tokens))),
          h("div", null, h("div", { className: "uq-sub" }, L === "zh" ? "30 天调用" : "30d calls"), h("div", { className: "uq-big" }, lg.month.calls.toLocaleString()))),
        top.map(function (r) {
          const planish = r.apiCost === 0 && r.tokens > 0;
          const tipText = r.models.map(function (x) { return x.model + ": " + kilo(x.tokens) + " tok" + (x.apiCost > 0 ? (" / " + money(x.apiCost, cur)) : ""); }).join(" · ");
          return h("div", { key: r.provider, className: "uq-row", style: { display: "block" } },
            tip(tipText, h("div", { style: { display: "flex", justifyContent: "space-between", gap: 10 } },
              h("span", { className: "uq-l" }, channelLabel(r.provider, L), planish ? h("span", { className: "uq-sub" }, " · " + (L === "zh" ? "套餐" : "plan")) : null),
              h("span", { className: "uq-v" }, kilo(r.tokens), r.apiCost > 0 ? h("span", { className: "uq-sub" }, " · " + money(r.apiCost, cur)) : null))),
            Bar(r.tokens / maxTok, false, false));
        }),
        (live || wb) ? h("div", { className: "uq-models" },
          live && live.credits ? h("div", { className: "uq-mrow" }, h("span", null, "CodeArts " + (L === "zh" ? "积分" : "credits")), h("span", null, String(live.credits.remaining ?? live.credits.total ?? "?"))) : null,
          live && live.creditsError ? h("div", { className: "uq-err" }, "CodeArts: " + live.creditsError) : null,
          wb && wb.credits ? h("div", { className: "uq-mrow" }, h("span", null, "WorkBuddy " + (L === "zh" ? "积分" : "credits")), h("span", null, String(wb.credits.remaining ?? wb.credits.total ?? JSON.stringify(wb.credits).slice(0, 60)))) : null
        ) : null);
    }
    function WhaleSection({ core, extra, L }) {
      useCfgVersion();  // 币种改动后重渲染
      const __cw = getCfg && getCfg();
      const cur = (core.money && core.money.currency) || (__cw && __cw.currency) || "CNY";
      const w = core.whale || {};
      const live = extra.whaleLive;
      if (!w.present && !live) return null;
      const bal = live && Number.isFinite(live.totalBalance) ? live.totalBalance : (Number.isFinite(w.lastBalance) ? w.lastBalance : null);
      const today = live && Number.isFinite(live.todayUsage) ? live.todayUsage : (Number.isFinite(w.todayUsage) ? w.todayUsage : null);
      const lt = w.lastTurn;
      return h("div", { className: "uq-card", style: { marginTop: 10 } },
        h("div", { className: "uq-row" },
          h("span", { className: "uq-l" }, Dot(Boolean(live)), " ", L === "zh" ? "小鲸鱼观测" : "Whale observed"),
          h("span", { className: "uq-v" }, today === null ? "—" : money(today, cur))),
        bal !== null ? h("div", { className: "uq-mrow" }, h("span", { className: "uq-dim" }, L === "zh" ? "最近观测余额" : "last seen balance"), h("span", null, money(bal, cur))) : null,
        lt ? h("div", { className: "uq-mrow" }, h("span", { className: "uq-dim" }, (L === "zh" ? "最近一轮 #" : "last turn #") + lt.turn), h("span", null, money(lt.amount, cur) + " · " + kilo(lt.tokens))) : null,
        (live && live.isPeak !== undefined) ? h("div", { className: "uq-mrow" }, h("span", { className: "uq-dim" }, L === "zh" ? "峰谷" : "peak"), h("span", null, live.isPeak ? (L === "zh" ? "高峰" : "peak") : (L === "zh" ? "谷时" : "off-peak"))) : null);
    }
    function Popover({ core, extra, L, busy, onRefresh, onClose, pos, onOpenDetail }) {
      const zh = L === "zh";
      useCfgVersion(); // 显隐开关改动后立即生效
      const gcfg = getCfg && getCfg();
      const showOfficial = !gcfg || gcfg.showOfficialBalance !== false;
      const showChannelCredits = !gcfg || gcfg.showChannels !== false;
      const showWhale = !gcfg || gcfg.showWhale !== false;
      const [tab, setTab] = react.useState("overview");
      const lg = core.ledger;
      const cur = (core.money && core.money.currency) || (lg && lg.currency) || "CNY";
      const rate = core.money && core.money.rate ? core.money.rate : 1;
      const wallets = core.official && Array.isArray(core.official.wallets) ? core.official.wallets : null;
      const official = wallets && wallets.length ? wallets.reduce(function (s, w) { return s + (Number(w.total) || 0); }, 0) : (lg && lg.official ? Number(lg.official.total) : null);
      const chRows = core.channels && core.channels.credits ? core.channels.credits : [];
      const chOk = chRows.filter(function (r) { return r.credits && Number.isFinite(r.credits.total); }).length;
      const today = lg ? lg.today : null;
      const month = lg ? lg.month : null;
      // 概览三栏：余额 / 今日 / 30 天
      const hero = h("div", { className: "uq-hero" },
        h("div", { className: "uq-hero-cell" },
          h("div", { className: "uq-hero-label" }, Dot(official !== null), zh ? "官方余额" : "Balance"),
          h("div", { className: "uq-hero-value" }, official === null ? "—" : money(official, cur)),
          h("div", { className: "uq-hero-sub" }, core.money && core.money.date ? (zh ? "汇率 " : "fx ") + core.money.rate.toFixed(4) + (core.money.stale ? " ·" : "") : "")),
        h("div", { className: "uq-hero-cell" },
          h("div", { className: "uq-hero-label" }, zh ? "今日实付" : "Today"),
          h("div", { className: "uq-hero-value" }, today ? money(today.apiCost || 0, cur) : "—"),
          h("div", { className: "uq-hero-sub" }, today ? kilo(today.tokens) + " tok · " + today.calls + (zh ? " 次" : "") : "")),
        h("div", { className: "uq-hero-cell" },
          h("div", { className: "uq-hero-label" }, zh ? "渠道额度" : "Channels"),
          h("div", { className: "uq-hero-value" }, chOk + " / " + (chRows.length || 0)),
          h("div", { className: "uq-hero-sub" }, zh ? "可用 / 已接入" : "ok / total")));
      const seg = function (items) {
        return h("div", { className: "uq-seg2" }, items.map(function (it) {
          return h("button", { key: it[0], "data-on": tab === it[0] ? "1" : "0", onClick: function () { setTab(it[0]); } }, it[1]);
        }));
      };
      const body =
        tab === "overview" ? h("div", null,
          showOfficial ? h(OfficialSection, { core: core, L: L }) : null,
          h(UsageSection, { core: core, extra: extra, L: L }),
          showWhale ? h(WhaleSection, { core: core, extra: extra, L: L }) : null)
        : tab === "channels" ? h("div", null, h(ChannelsSection, { core: core, extra: extra, L: L }))
        : h("div", null,
          h("div", { className: "uq-stats" },
            h("div", null, h("div", { className: "k" }, zh ? "今日" : "Today"), h("div", { className: "v" }, today ? money(today.cost || 0, cur) : "—")),
            h("div", null, h("div", { className: "k" }, zh ? "30 天等值" : "30d equiv"), h("div", { className: "v" }, month ? money(month.cost || 0, cur) : "—")),
            h("div", null, h("div", { className: "k" }, zh ? "30 天实付" : "30d paid"), h("div", { className: "v" }, month ? money(month.apiCost || 0, cur) : "—")),
            h("div", null, h("div", { className: "k" }, zh ? "30 天调用" : "30d calls"), h("div", { className: "v" }, month ? month.calls.toLocaleString() : "—"))),
          h(UsageSection, { core: core, extra: extra, L: L }));
      return h("div", { className: "uq-pop", style: { top: pos.top, left: pos.left }, role: "dialog", onClick: function (e) { e.stopPropagation(); } },
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
          h("strong", { style: { fontSize: 13 } }, zh ? "额度中心" : "Quota Center"),
          h("span", { style: { display: "inline-flex", gap: 2 } },
            h("button", { className: "uq-btn", "data-tip": dict[L].refresh, onClick: function () { void onRefresh(true); } }, busy ? h("span", { className: "uq-spin" }, "⟳") : (GlyphRefresh ? h(GlyphRefresh, { size: 13 }) : "⟳")),
            h("button", { className: "uq-btn", "data-tip": "×", onClick: onClose }, "×"))),
        hero,
        h("div", { className: "uq-toolbar" }, seg((function () {
          const list = [["overview", zh ? "概览" : "Overview"]];
          if (showChannelCredits) list.push(["channels", zh ? "渠道" : "Channels"]);
          list.push(["cost", zh ? "费用" : "Cost"]);
          return list;
        })())),
        h("div", { className: "uq-body", style: { padding: 0, maxHeight: "46vh", overflow: "auto" } }, body),
        h("button", { className: "uq-more", type: "button", onClick: function () { onOpenDetail(); } },
          zh ? "打开多平台明细 →" : "Open details →"));
    }
    //#endregion
    //#region settings
    const CURRENCIES = [["CNY", "¥ 人民币"], ["USD", "$ 美元"], ["EUR", "€ 欧元"]];
    const BASES = [["api", "实付（真金白银）"], ["total", "实付 + 等值"], ["plan", "仅等值（套餐参考）"]];
    const LOCALES = [["auto", "跟随界面"], ["zh", "中文"], ["en", "English"]];
    function Field({ label, hint, children }) {
      return h("div", { className: "uq-field" }, h("label", null, label, hint ? h("small", null, hint) : null), children);
    }
    function Switch({ on, onChange }) {
      // 全内联样式：截图显示开关是空白框，说明 class 样式未生效（可能 CSS 注入时序问题）
      return h("div", {
        style: {
          position: "relative", width: 34, height: 18, borderRadius: 9, cursor: "pointer", flex: "none",
          background: on ? "#4d6bfe" : "#3a3a41",
          border: "1px solid " + (on ? "transparent" : "#4a4a53"),
          transition: "background .15s",
        },
        role: "switch", "aria-checked": on ? "true" : "false", tabIndex: 0,
        onClick: function () { onChange(!on); },
        onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!on); } },
      }, h("i", {
        style: {
          position: "absolute", top: 2, left: on ? 18 : 2, width: 12, height: 12,
          borderRadius: "50%", background: "#fff", transition: "left .15s",
        },
      }));
    }
    function Select({ value, options, onChange }) {
      return h("select", { className: "uq-select", value: value, onChange: function (e) { onChange(e.target.value); } },
        options.map(function (o) { return h("option", { key: o[0], value: o[0] }, o[1]); }));
    }
    /**
     * 共享配置缓存：设置页读到/改动配置时同步到这里，其它组件用 getCfg() 读取。
     * 这样任何一个设置项都能在**所有**组件里生效，而不是只在设置页自身生效（曾经的假开关问题）。
     */
    let sharedCfg = null;
    // 配置变更通知：所有读 getCfg() 的组件订阅它，改动后自动重渲染。
    // 之前只有 sharedCfg 变量更新，组件读的是渲染时的快照 ⇒ 改了设置界面不变。
    let cfgVersion = 0;
    const cfgListeners = new Set();
    function setSharedCfg(next) {
      sharedCfg = next;
      cfgVersion += 1;
      for (const fn of cfgListeners) { try { fn(cfgVersion); } catch (e) {} }
    }
    /** 主动拉一次 config（含 money），更新 sharedCfg 并通知订阅者。 */
    let moneyState = null;
    const moneyListeners = new Set();
    function refreshMoney() {
      return fetch(CONFIG_URL, { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          if (j.config) setSharedCfg(j.config);
          if (j.money) { moneyState = j.money; for (const fn of moneyListeners) { try { fn(moneyState); } catch (e) {} } }
        })
        .catch(function () {});
    }
    function useMoney() {
      const [v, setV] = react.useState(moneyState);
      react.useEffect(function () {
        const fn = function (nv) { setV(nv); };
        moneyListeners.add(fn);
        if (moneyState === null) void refreshMoney();
        return function () { moneyListeners.delete(fn); };
      }, []);
      return v;
    }

    /** 订阅配置变更；返回取消函数。组件里用 useState 接版本号即可触发重渲染。 */
    function useCfgVersion() {
      const [v, setV] = react.useState(cfgVersion);
      react.useEffect(function () {
        const fn = function (nv) { setV(nv); };
        cfgListeners.add(fn);
        return function () { cfgListeners.delete(fn); };
      }, []);
      return v;
    }
    function getCfg() { return sharedCfg; }
    function useConfig() {
      const [cfg, setCfg] = react.useState(null);
      const [money, setMoney] = react.useState(null);
      const [fetchedPrices, setFetchedPrices] = react.useState({});
      const [fetchedAt, setFetchedAt] = react.useState(null);
      const [fetchedDetail, setFetchedDetail] = react.useState({});
      const [modelList, setModelList] = react.useState([]);
      const [modelCacheRates, setModelCacheRates] = react.useState({});
      // 渠道清单由后端给（roster ∪ 账本），新增渠道自动出现，无需改代码
      const [providers, setProviders] = react.useState([]);
      const [error, setError] = react.useState(null);
      const [saved, setSaved] = react.useState(false);
      const savedTimer = react.useRef(null);
      react.useEffect(function () {
        let alive = true;
        fetchJson(CONFIG_URL).then(function (j) { if (alive) { setCfg(j && j.config ? j.config : null); setSharedCfg(j && j.config ? j.config : sharedCfg); setMoney(j && j.money ? j.money : null);
          setFetchedPrices(j && j.fetchedPrices ? j.fetchedPrices : {});
          setFetchedAt(j && j.fetchedAt ? j.fetchedAt : null);
          setFetchedDetail(j && j.fetchedDetail ? j.fetchedDetail : {});
          setModelList(j && j.modelList ? j.modelList : []);
          setModelCacheRates(j && j.modelCacheRates ? j.modelCacheRates : {}); if (j && Array.isArray(j.providers)) setProviders(j.providers); } },
          function (e) { if (alive) setError(String(e && e.message || e)); });
        return function () { alive = false; };
      }, []);
      const patch = react.useCallback(function (delta) {
        setCfg(function (cur) { return cur === null ? cur : { ...cur, ...delta }; });
        fetch(CONFIG_URL, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(delta) })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && j.config) { setCfg(j.config); setSharedCfg(j.config); }
            // 立即用后端返回的 money 更新汇率/币种（不用再 GET 一次，避免慢一拍）
            if (j && j.money) { setMoney(j.money); moneyState = j.money; for (const fn of moneyListeners) { try { fn(j.money); } catch (e) {} } }
            setSaved(true); if (savedTimer.current) clearTimeout(savedTimer.current); savedTimer.current = setTimeout(function () { setSaved(false); }, 1200); })
          .catch(function (e) { setError(String(e && e.message || e)); });
      }, []);
      const refreshRates = react.useCallback(function () {
        fetch(CONFIG_URL, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ refreshRates: true }) })
          .then(function () { return fetchJson(CONFIG_URL); })
          .then(function (j) { if (j && j.money) setMoney(j.money); if (j && j.config) { setCfg(j.config); setSharedCfg(j.config); } })
          .catch(function (e) { setError(String(e && e.message || e)); });
      }, []);
      return { cfg: cfg, money: money, providers: providers, fetchedPrices: fetchedPrices, fetchedAt: fetchedAt, fetchedDetail: fetchedDetail, modelList: modelList, modelCacheRates: modelCacheRates, error: error, saved: saved, patch: patch, refreshRates: refreshRates };
    }
    /**
 * 版本提示卡（GitHub 检查到新版时显示）。
 * ⚠️ 必须用 h(VersionNotice, props) 调用 —— 内部含 useState/useEffect，
 *    直接 VersionNotice(props) 会违反 Hooks 规则导致白屏（7.25.1 踩过）。
 */
function VersionNotice(props) {
  const zh = props.zh;
  const [ver, setVer] = react.useState(null);
  react.useEffect(function () {
    fetchJson("/api/unified-quota/version?t=" + Date.now()).then(function (v) {
      if (v && v.latest && v.current && v.latest !== v.current) setVer(v);
    }).catch(function () {});
  }, []);
  if (!ver) return null;
  return h("div", { style: { marginBottom: 12, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(201,169,90,.5)", background: "rgba(201,169,90,.08)", fontSize: 11 } },
    h("b", { style: { color: "#c9a95a" } }, zh ? "有新版本可用" : "New version available"),
    h("span", { className: "uq-sub", style: { marginLeft: 6 } }, ver.current + " → " + ver.latest),
    h("div", { className: "uq-sub", style: { marginTop: 4 } },
      zh ? "运行 update.bat 更新，或到 GitHub Release 下载" : "Run update.bat or download from GitHub Release"),
    ver.url ? h("a", { href: ver.url, target: "_blank", rel: "noopener", style: { color: "#8fa4ff", fontSize: 11 } }, "GitHub Release ↗") : null);
}

const SYNC_STATUS_URL = "/api/unified-quota/sync/status";
const SYNC_UPLOAD_URL = "/api/unified-quota/sync/upload";
const SYNC_RESTORE_URL = "/api/unified-quota/sync/restore";

/** 坚果云同步设置块（上传 / 恢复 / 差异对比）。独立函数避免 JSX 嵌套过深。 */
function webdavSettings(props) {
  const cfg = props.cfg, zh = props.zh, P = props.P;
  const wd = cfg.webdav || { user: "", pass: "" };
  const [status, setStatus] = react.useState({ loading: true, data: null, error: null });
  const [busy, setBusy] = react.useState("");
  const [msg, setMsg] = react.useState("");
  const mounted = react.useRef(true);
  react.useEffect(function () { return function () { mounted.current = false; }; }, []);

  const loadStatus = react.useCallback(function () {
    setStatus(function (s) { return Object.assign({}, s, { loading: true }); });
    fetchJson(SYNC_STATUS_URL + "?t=" + Date.now()).then(function (j) {
      if (mounted.current) setStatus({ loading: false, data: j, error: j && j.ok ? null : (j && j.error) || "读取失败" });
    }, function (e) {
      if (mounted.current) setStatus({ loading: false, data: null, error: String((e && e.message) || e) });
    });
  }, []);

  react.useEffect(function () { loadStatus(); }, [loadStatus]);

  const configured = !!(wd.user && wd.pass);
  const st = status.data;

  const doUpload = function () {
    setBusy("upload"); setMsg("");
    fetch(SYNC_UPLOAD_URL, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        setBusy("");
        if (j && j.ok) { setMsg(zh ? ("✓ 已上传 " + (j.files || []).length + " 个文件，" + Math.round((j.bytes || 0) / 1024) + " KB") : "✓ uploaded"); loadStatus(); }
        else setMsg("✗ " + ((j && j.error) || "失败"));
      })
      .catch(function (e) { setBusy(""); setMsg("✗ " + String((e && e.message) || e)); });
  };

  const doRestore = function () {
    const warn = zh
      ? "确定要从云端恢复吗？\n\n本地当前数据会先备份为 .bak-<时间戳> 文件，然后用云端数据覆盖。"
      : "Restore from cloud?\n\nLocal data will be backed up as .bak-<ts> first, then overwritten.";
    if (!window.confirm(warn)) return;
    setBusy("restore"); setMsg("");
    fetch(SYNC_RESTORE_URL, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, backupLocal: true }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        setBusy("");
        if (j && j.ok) { setMsg(zh ? ("✓ 已恢复 " + (j.written || []).length + " 个文件（本地已备份 " + (j.backedUp || []).length + " 个）") : "✓ restored"); loadStatus(); }
        else setMsg("✗ " + ((j && j.error) || "失败"));
      })
      .catch(function (e) { setBusy(""); setMsg("✗ " + String((e && e.message) || e)); });
  };

  const rows = (st && st.rows) || [];

  return [
    h("div", { key: "wd-cred" },
      Field({ label: zh ? "坚果云账号" : "Nutstore account",
        hint: zh ? "邮箱。凭证只存本地 config.json，绝不上传" : "Email; stored locally only",
        children: h("input", { className: "uq-input", type: "text", style: { width: 240 }, placeholder: "you@example.com",
          value: wd.user || "", onChange: function (e) { P("webdav", { user: e.target.value, pass: wd.pass || "" }); },
          onBlur: function (e) { const v = String(e.target.value || "").trim(); if (v !== e.target.value) P("webdav", { user: v, pass: wd.pass || "" }); } }) }),
      Field({ label: zh ? "应用密码" : "App password",
        hint: zh ? "坚果云 → 设置 → 安全 → 应用密码（不是登录密码）" : "Nutstore → Settings → Security → App password",
        children: h("input", { className: "uq-input", type: "password", style: { width: 240 }, placeholder: zh ? "应用密码" : "app password",
          value: wd.pass || "", onChange: function (e) { P("webdav", { user: wd.user || "", pass: e.target.value }); },
          onBlur: function (e) { const v = String(e.target.value || "").trim(); if (v !== e.target.value) P("webdav", { user: wd.user || "", pass: v }); } }) })),
    h("div", { key: "wd-auto", style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
      Switch({ on: wd.autoSync === true, onChange: function (v) { P("webdav", { user: wd.user || "", pass: wd.pass || "", autoSync: v }); } }),
      h("span", { className: "uq-sub" }, zh ? "自动同步（每 5 分钟，仅凭证存在时生效）" : "Auto-sync (every 5 min, when configured)")),
    h("div", { key: "wd-act", style: { display: "flex", gap: 8, alignItems: "center", margin: "10px 0", flexWrap: "wrap" } },
      h("button", { className: "uq-btn", disabled: !configured || busy !== "", onClick: doUpload },
        busy === "upload" ? (zh ? "上传中…" : "Uploading…") : (zh ? "立即上传备份" : "Upload now")),
      h("button", { className: "uq-btn", disabled: !configured || busy !== "", onClick: doRestore },
        busy === "restore" ? (zh ? "恢复中…" : "Restoring…") : (zh ? "从云端恢复" : "Restore")),
      h("button", { className: "uq-btn", disabled: !configured || busy !== "", onClick: loadStatus, "data-tip": zh ? "刷新对比" : "Refresh" }, "↻"),
      h("span", { style: { flex: 1 } }),
      h("span", { className: "uq-sub" }, st && st.device ? (zh ? "本机：" : "device: ") + st.device : "")),
    h("div", { key: "wd-msg", className: "uq-sub", style: { marginBottom: 8, color: msg.indexOf("✓") === 0 ? "#3fb950" : (msg.indexOf("✗") === 0 ? "#e06c75" : undefined) } },
      msg || (status.error ? (zh ? "读取失败：" : "failed: ") + status.error : (status.loading ? (zh ? "读取云端状态…" : "loading…") : ""))),
    h("div", { key: "wd-cmp" },
      st && st.remoteExists === false ? h("div", { className: "uq-sub" }, zh ? "云端还没有备份" : "no remote backup yet")
      : rows.length ? h("div", null,
          h("div", { className: "uq-sub", style: { marginBottom: 4 } },
            (zh ? "本地：" : "local: ") + (st.localAt ? new Date(st.localAt).toLocaleString("zh-CN") : "—") +
            "  ·  " + (zh ? "云端：" : "cloud: ") + (st.remoteAt ? new Date(st.remoteAt).toLocaleString("zh-CN") : "—") +
            (st.remoteNewer ? (zh ? "  ⚠ 云端更新" : "  ⚠ cloud newer") : "")),
          h("table", { className: "uq-table" },
            h("thead", null, h("tr", null,
              h("th", null, zh ? "文件" : "file"),
              h("th", { className: "num" }, zh ? "本地" : "local"),
              h("th", { className: "num" }, zh ? "云端" : "cloud"),
              h("th", null, zh ? "差异" : "diff"))),
            h("tbody", null, rows.map(function (r) {
              const tag = r.onlyLocal ? (zh ? "仅本地" : "local only")
                : r.onlyRemote ? (zh ? "仅云端" : "cloud only")
                : r.differs ? (zh ? "大小不同" : "size differs") : (zh ? "一致" : "same");
              return h("tr", { key: r.key },
                h("td", null, r.label),
                h("td", { className: "num" }, r.localBytes ? Math.round(r.localBytes / 1024) + " KB" : "—"),
                h("td", { className: "num" }, r.remoteBytes ? Math.round(r.remoteBytes / 1024) + " KB" : "—"),
                h("td", { className: "uq-sub" }, tag));
            }))))
        : null),
  ];
}

/** 假定缓存命中率设置块（自动反推为主，手填仅覆盖）。独立函数避免 JSX 嵌套过深。 */
function cacheHitSettings(props) {
  const cfg = props.cfg, st = props.st, zh = props.zh, L = props.L, P = props.P;
  const ac = cfg.assumedCacheHit || {};
  const rates = st.modelCacheRates || {};
  const all = [...new Set([...(st.modelList || []), ...Object.keys(ac)])].sort();
  const needManual = all.filter(function (m) { return !rates[m]; });
  const shown = props.showAll ? all : [...new Set(needManual.concat(Object.keys(ac)))].sort();
  const head = h("div", { key: "__sum", className: "uq-sub", style: { marginBottom: 6 } },
    zh ? ("共 " + all.length + " 个模型：已自动反推 " + (all.length - needManual.length) + " 个，需手填 " + needManual.length + " 个")
       : (all.length + " models, " + needManual.length + " need manual"));
  const toggle = all.length > 6
    ? h("div", { key: "__tg", style: { marginBottom: 6 } },
        h("button", { className: "uq-btn", onClick: function () { props.setShowAll(!props.showAll); } },
          props.showAll ? (zh ? "只看需手填的" : "manual only") : (zh ? "显示全部 " + all.length + " 个" : "show all " + all.length)))
    : null;
  const rows = shown.map(function (p) {
    const cur = ac[p];
    const auto = rates[p];
    const hint = auto
      ? ((zh ? "自动反推 " : "auto ") + (auto.rate * 100).toFixed(1) + "%" + (cur !== undefined ? (zh ? " · 手填覆盖中" : " · overridden") : ""))
      : (zh ? "无反推值，需手填" : "manual needed");
    return h("div", { className: "uq-field", key: "ac-" + p },
      h("label", null, p, h("small", null, hint)),
      h("input", { className: "uq-input", type: "number", min: "0", max: "100", step: "1", style: { width: 90 },
        placeholder: zh ? "如 84" : "e.g. 84",
        value: cur === undefined || cur === null ? "" : String(Math.round(cur * 100)),
        onChange: function (e) {
          const raw = String(e.target.value || "").trim();
          const next = Object.assign({}, ac);
          if (raw === "") { delete next[p]; }
          else { const v = Number(raw); if (!(Number.isFinite(v) && v >= 0 && v <= 100)) return; next[p] = v / 100; }
          P("assumedCacheHit", next);
        } }));
  });
  return [head, toggle].concat(rows);
}

/** 可折叠的设置分组。默认折叠状态存在 localStorage，跨会话保留。 */
const UQ_GROUP_KEY = "uq-set-collapsed";
function __uqLoadCollapsed() {
  try { const raw = localStorage.getItem(UQ_GROUP_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === "object") ? o : {}; } catch (e) { return {}; }
}
function __uqSaveCollapsed(o) {
  try { localStorage.setItem(UQ_GROUP_KEY, JSON.stringify(o)); } catch (e) {}
}
function CollapsibleGroup(props) {
  // h(CollapsibleGroup, props, ...children) 时 React 会把子元素放进 props.children
  const rawChildren = props.children;
  const children = (Array.isArray(rawChildren) ? rawChildren : [rawChildren]).filter(function (c) { return c !== null && c !== undefined && c !== false; });
  const key = props.id;
  const [collapsed, setCollapsed] = react.useState(function () {
    const m = __uqLoadCollapsed();
    // 未记录过的分组：按 defaultCollapsed 决定
    return m[key] === undefined ? props.defaultCollapsed === true : m[key] === true;
  });
  const toggle = function () {
    setCollapsed(function (v) {
      const next = !v;
      const m = __uqLoadCollapsed();
      m[key] = next;
      __uqSaveCollapsed(m);
      return next;
    });
  };
  return h("div", { className: "uq-set-group" },
    h("h4", {
      onClick: toggle,
      style: { cursor: "pointer", display: "flex", alignItems: "center", gap: 6, userSelect: "none" },
      "data-tip": collapsed ? "点击展开" : "点击收起",
      role: "button",
      tabIndex: 0,
      onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } },
    },
      h("span", { style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary,#8a8a93)", transition: "transform .15s", display: "inline-block", transform: collapsed ? "rotate(-90deg)" : "none" } }, "▾"),
      h("span", null, props.title),
      props.badge ? h("span", { className: "uq-sub", style: { marginLeft: 6, fontWeight: 400 } }, props.badge) : null),
    collapsed ? null : h("div", null, children));
}

function SettingsSection() {
      ensureCss();
      useCfgVersion();
      // 兜底：挂载时主动拉一次（useConfig 的初始 fetch 可能因时序未完成）
      react.useEffect(function () { try { if (typeof refreshMoney === "function") refreshMoney(); } catch (e) {} }, []);
      const L = locale();
      const st = useConfig();
      const cfg = st.cfg;
      const moneyLive = useMoney(); // 用订阅式 money，确保有数据
      const money = moneyLive || st.money;
      // 「假定缓存命中率」列表超长时折叠（必须放在所有 hooks 之后、early return 之前）
      const [showAllCacheModels, setShowAllCacheModels] = react.useState(false);
      const zh = L === "zh";
      if (st.error) return h("div", { className: "uq-set" }, h("div", { className: "uq-err" }, (zh ? "配置读取失败：" : "Failed: ") + st.error));
      if (!cfg) return h("div", { className: "uq-loading" }, zh ? "读取配置…" : "Loading…");
      const P = function (k, v) { const d = {}; d[k] = v; st.patch(d); };
      // 每个设置项都带 hint 小字：说明「这是什么 + 改了影响哪里」，避免"不知道有没有用"
      return h("div", { className: "uq-set" },
        // ── 金额与币种 ──
        h(CollapsibleGroup, { id: "money", title: zh ? "金额与币种" : "Money & currency", defaultCollapsed: false },
          Field({ label: zh ? "显示币种" : "Currency", hint: zh ? "面板里所有金额的符号" : "Symbol for all amounts",
            children: Select({ value: cfg.currency, options: CURRENCIES, onChange: function (v) { P("currency", v); } }) }),
          Field({ label: zh ? "汇率（每日自动）" : "Rate (daily)",
            hint: (function () {
              if (!money || !money.date) return zh ? "尚未取到，使用配置值" : "Using configured value";
              const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
              const isToday = money.date === today;
              const curSym = (money && money.currency) || "CNY";
        const base = (zh
          ? "基准 USD · 1 USD = " + (money.rate || 0).toFixed(4) + " " + curSym + " · 欧洲央行参考价 · "
          : "base USD · 1 USD = " + (money.rate || 0).toFixed(4) + " " + curSym + " · ECB ref · ") + money.date;
              if (money.error) return base + (zh ? " · 刷新失败：" : " · refresh failed: ") + String(money.error).slice(0, 40);
              if (!isToday) return base + (zh ? " · 欧洲央行今日未发布新价（周末/假日），沿用此价" : " · ECB has not published today (weekend/holiday), reusing");
              return base + (money.stale ? (zh ? " · 沿用上次" : " · cached") : "");
            })(),
            children: h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
              h("span", { style: { fontVariantNumeric: "tabular-nums", fontSize: 12 } }, money && money.rate ? money.rate.toFixed(4) : "—"),
              h("button", { className: "uq-btn", "data-tip": zh ? "立即刷新汇率" : "Refresh rate", onClick: function () { st.refreshRates(); } }, GlyphRefresh ? h(GlyphRefresh, { size: 12 }) : "⟳")) }),
          Field({ label: zh ? "手动指定汇率" : "Manual rate",
            hint: zh ? "填了就用这个值（覆盖自动抓取）。周末/节假日 ECB 不发布新价时，可手动修正。" : "Override the auto-fetched rate (useful on weekends/holidays)",
            children: h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
              h("input", { className: "uq-input", type: "number", min: "0", step: "0.0001", style: { width: 100 },
                placeholder: zh ? "自动" : "auto",
                value: cfg.manualRate === undefined || cfg.manualRate === null || Number(cfg.manualRate) <= 0 ? "" : String(cfg.manualRate),
                onChange: function (e) {
                  const raw = String(e.target.value || "").trim();
                  if (raw === "") { P("manualRate", 0); return; }
                  const v = Number(raw);
                  if (Number.isFinite(v) && v >= 0) P("manualRate", v);
                } }),
              Number(cfg.manualRate) > 0
                ? h("button", { className: "uq-btn", onClick: function () { P("manualRate", 0); }, "data-tip": zh ? "恢复自动" : "Back to auto" }, "↺")
                : h("span", { className: "uq-sub" }, zh ? "（自动）" : "(auto)")) }),
          Field({ label: zh ? "小数位数" : "Decimals", hint: zh ? "全局控制金额显示几位小数；改动立即生效" : "Global decimal places; applies immediately",
            children: h("input", { className: "uq-input", type: "number", min: "0", max: "8", value: cfg.decimals,
              onChange: function (e) { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 0 && v <= 8) P("decimals", v); } }) })),
        // ── 积分单价（套餐性价比对比用）──
        h(CollapsibleGroup, { id: "creditPrice", title: zh ? "积分单价 · 套餐性价比" : "Credit price", defaultCollapsed: true },
          h("div", { className: "uq-sub", style: { marginBottom: 8 } },
            zh ? "渠道 API 不返回套餐价格，需要你手填「1 积分 = 多少元」。填了之后，额度窗口和积分账单会显示折算后的真实花费，方便横向对比哪家套餐更划算。" : "Fill in the price per credit to see real spend and compare packages."),
          (function () {
            const cp = cfg.creditPrices || {};
            const fp = st.fetchedPrices || {};
            // 恢复完整渠道列表（用户要求不要精简，长度问题留给折叠/多页解决）
            const provs = [...new Set([...(st.providers || []), ...Object.keys(cp), ...Object.keys(fp)])].sort();
            return provs.map(function (p) {
              const f = fp[p];
              const detail = (st.fetchedDetail || {})[p];
              const isFallback = !!(detail && detail.fallback === true);
              const fetchedText = f
                ? ((isFallback ? (zh ? "⚠ 快照值 ¥" : "snapshot ¥") : (zh ? "自动抓取 ¥" : "auto ¥")) + f.perCredit.toFixed(5) + (f.plan ? (zh ? "（" : " (") + f.plan + (zh ? "，请核对官网" : ", verify on site") + (zh ? "）" : ")") : ""))
                : (zh ? "未抓取到，用默认 ¥0.0106" : "not fetched, default ¥0.0106");
              return h("div", { className: "uq-field", key: "cp-" + p },
                h("label", null, channelLabel(p, L), h("small", null, fetchedText)),
                h("input", { className: "uq-input", type: "number", min: "0", step: "0.0001", style: { width: 120 },
                  placeholder: zh ? "如 0.01" : "e.g. 0.01",
                  value: cp[p] === undefined || cp[p] === null ? "" : String(cp[p]),
                  onChange: function (e) {
                    const raw = String(e.target.value || "").trim();
                    const next = Object.assign({}, cp);
                    if (raw === "") { delete next[p]; } else { const v = Number(raw); if (!(Number.isFinite(v) && v >= 0)) return; next[p] = v; }
                    P("creditPrices", next);
                  } }));
            });
          })()),
        // ── 假定缓存命中率（按模型；自动反推为主，手填仅作覆盖）──
        h(CollapsibleGroup, { id: "cacheHit", title: zh ? "假定缓存命中率" : "Assumed cache hit", defaultCollapsed: true },
          h("div", { className: "uq-sub", style: { marginBottom: 8 } },
            zh ? "大多数模型已能按「同模型跨渠道」自动反推命中率，无需手填。只有反推不到时才需手动指定（0-100%）。缓存命中比未命中便宜 50 倍，影响很大。" : "Most models are auto-inferred. Fill only when unavailable."),
          cacheHitSettings({ cfg: cfg, st: st, zh: zh, L: L, P: P, showAll: showAllCacheModels, setShowAll: setShowAllCacheModels })),
        // ── 计价方式 ──
        h(CollapsibleGroup, { id: "pricing", title: zh ? "计价方式" : "Pricing", defaultCollapsed: true },
          Field({ label: zh ? "峰谷计价" : "Peak / off-peak", hint: zh ? "DeepSeek 官方高峰时段价格更高；影响费用估算" : "DeepSeek peak-hour pricing; affects estimates",
            children: Switch({ on: cfg.peakEnabled, onChange: function (v) { P("peakEnabled", v); } }) }),
          Field({ label: zh ? "默认计价口径" : "Default cost basis", hint: zh ? "打开明细页默认用哪一列：实付 / 合计 / 等值" : "Default column when opening details",
            children: Select({ value: cfg.statisticsBasis, options: BASES, onChange: function (v) { P("statisticsBasis", v); } }) })),
        // ── 显示内容 ──
        h(CollapsibleGroup, { id: "visibility", title: zh ? "显示内容" : "Visibility", defaultCollapsed: false },
          h("div", { className: "uq-sub", style: { marginBottom: 6 } }, zh ? "控制侧栏弹层里显示哪些区块" : "Which blocks appear in the sidebar popover"),
          Field({ label: zh ? "DeepSeek 官方余额" : "Official balance", hint: zh ? "关掉后弹层「概览」不再显示官方余额区" : "Hide the official balance section in Overview",
            children: Switch({ on: cfg.showOfficialBalance, onChange: function (v) { P("showOfficialBalance", v); } }) }),
          Field({ label: zh ? "渠道积分（Jet Hub）" : "Channel credits", hint: zh ? "关掉后弹层不再显示「渠道」标签页" : "Hide the Channels tab in the popover",
            children: Switch({ on: cfg.showChannels, onChange: function (v) { P("showChannels", v); } }) }),
          Field({ label: zh ? "小鲸鱼观测" : "Whale observations", hint: zh ? "关掉后弹层「概览」不再显示小鲸鱼区" : "Hide the whale section in Overview",
            children: Switch({ on: cfg.showWhale, onChange: function (v) { P("showWhale", v); } }) }),
          Field({ label: zh ? "侧栏紧凑模式" : "Compact sidebar", hint: zh ? "侧栏只留金额与状态点，隐藏渠道数/今日金额" : "Sidebar shows amount + status dot only",
            children: Switch({ on: cfg.sidebarCompact, onChange: function (v) { P("sidebarCompact", v); } }) })),
        // ── 明细页 ──
        h(CollapsibleGroup, { id: "detail", title: zh ? "明细页" : "Detail page", defaultCollapsed: false },
          Field({ label: zh ? "默认时间范围" : "Default window", hint: zh ? "打开多平台明细时默认选中：近 7/30/90 天" : "Default range when opening details",
            children: Select({ value: String(cfg.detailWindow), options: [["7", zh ? "近 7 天" : "7 days"], ["30", zh ? "近 30 天" : "30 days"], ["90", zh ? "近 90 天" : "90 days"]], onChange: function (v) { P("detailWindow", Number(v)); } }) }),
          Field({ label: zh ? "费用趋势图" : "Trend chart", hint: zh ? "关掉后明细页不再显示逐日堆叠柱状图" : "Hide the daily stacked trend chart",
            children: Switch({ on: cfg.showTrend, onChange: function (v) { P("showTrend", v); } }) }),
          Field({ label: zh ? "Token 构成" : "Token composition", hint: zh ? "关掉后「分析」区不再显示 Token 构成与缓存命中率" : "Hide token mix & cache-hit block in Analysis",
            children: Switch({ on: cfg.showComposition, onChange: function (v) { P("showComposition", v); } }) })),
        // ── 每日软上限 ──
        h(CollapsibleGroup, { id: "softLimits", title: zh ? "每日软上限 · 渠道默认（可选）" : "Daily soft limits · channel default", defaultCollapsed: true },
          h("div", { className: "uq-sub", style: { marginBottom: 8 } },
            zh ? "这里是渠道级默认。模型级更精确的限额在「多平台明细 → 额度窗口」里逐模型设置。留空 = 不限制。" : "Channel-level default. Per-model limits are set in Details -> Quota."),
          (function () {
            const sl = cfg.softLimits || {};
            const provs = [...new Set([...(st.providers || []), ...Object.keys(sl)])].sort();
            return provs.map(function (p) {
              const row = sl[p] || { requests: 0, tokens: 0 };
              return h("div", { className: "uq-field", key: p },
                h("label", null, channelLabel(p, L), h("small", null, zh ? "留 0 = 不限制" : "0 = no limit")),
                h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
                  h("input", { className: "uq-input", type: "number", min: "0", step: "1000", style: { width: 96 }, placeholder: zh ? "token 上限" : "token cap", value: row.tokens || "",
                    onChange: function (e) { const v = Math.max(0, Math.floor(Number(e.target.value) || 0)); const next = Object.assign({}, sl); next[p] = { requests: row.requests || 0, tokens: v, models: row.models || {} }; P("softLimits", next); } }),
                  h("input", { className: "uq-input", type: "number", min: "0", step: "1", style: { width: 78 }, placeholder: zh ? "次数上限" : "req cap", value: row.requests || "",
                    onChange: function (e) { const v = Math.max(0, Math.floor(Number(e.target.value) || 0)); const next = Object.assign({}, sl); next[p] = { requests: v, tokens: row.tokens || 0, models: row.models || {} }; P("softLimits", next); } })));
            });
          })()),
        // —— 版本提示（GitHub 检查到新版时显示）——
        h(VersionNotice, { zh: zh }),
        // —— 跨设备同步（坚果云 WebDAV）——
        h(CollapsibleGroup, { id: "webdav", title: zh ? "跨设备同步 · 坚果云 WebDAV" : "Cross-device sync · Nutstore", defaultCollapsed: true },
          h("div", { className: "uq-sub", style: { marginBottom: 8 } },
            zh ? "把账本 / 设置 / 限流状态备份到坚果云；换机或重装后可恢复。手动操作，不做自动合并。"
               : "Back up ledger/settings/caps to Nutstore; restore on another machine. Manual only."),
          h(webdavSettings, { cfg: cfg, zh: zh, P: P })),
        st.saved ? h("div", { className: "uq-save" }, zh ? "已保存" : "Saved") : null);
    }
    //#endregion
    //#region detail sheet
    const DETAIL_URL = "/api/unified-quota/detail";
    const CONFIG_URL = "/api/unified-quota/config";
    const CALLS_URL = "/api/unified-quota/calls";
    const CREDITS_URL = "/api/unified-quota/credits";
    const QUOTA_URL = "/api/unified-quota/quota";
    const CURRENT_URL = "/api/unified-quota/current";
    const EXPORT_URL = "/api/unified-quota/export";
    const WINDOWS = [[7, "7 天", "7d"], [30, "30 天", "30d"], [90, "90 天", "90d"]];
    const TABS = [["provider", "按渠道", "By channel"], ["model", "按模型", "By model"], ["day", "按日", "By day"], ["session", "按会话", "By session"], ["call", "逐次调用", "Per call"]];
    function useDetail(open, opts) {
      const [state, setState] = react.useState({ data: null, error: null, busy: false, at: 0 });
      const load = react.useCallback(async function (o) {
        setState(function (s) { return { data: s.data, error: null, busy: true, at: s.at }; });
        try {
          const q = "?window=" + o.window + "&provider=" + encodeURIComponent(o.provider || "") + "&model=" + encodeURIComponent(o.model || "") + "&credits=1" + (o.refreshFactors ? "&refreshFactors=1" : "");
          const j = await fetchJson(DETAIL_URL + q);
          setState({ data: j && j.detail ? j.detail : null, error: null, busy: false, at: Date.now() });
        } catch (e) {
          setState({ data: null, error: e && e.message ? String(e.message) : String(e), busy: false, at: 0 });
        }
      }, []);
      react.useEffect(function () { if (open) void load(opts); }, [open, opts.window, opts.provider, opts.model]);
      return { state: state, reload: load };
    }
    function Spark({ days, L }) {
      if (!days || !days.length) return null;
      const max = days.reduce(function (m, d) { return Math.max(m, d.tokens); }, 1);
      return h("div", { className: "uq-spark" }, days.map(function (d) {
        const plan = d.apiCost === 0 && d.tokens > 0;
        return tip(d.date + " · " + kilo(d.tokens) + " tok · " + money(d.apiCost, days.currency), h("i", {
          key: d.date, "data-plan": plan ? "1" : "0",
          style: { height: Math.max(2, Math.round((d.tokens / max) * 70)) + "px" }
        }));
      }));
    }
    function ProviderTable({ detail, L, basis }) {
  useCfgVersion();  // 币种/小数位改动后重渲染
  try { beacon("pt-render", "providers=" + ((detail && detail.providers) || []).length); } catch (x) {}
      basis = basis || "api";
      const zh = L === "zh";
      const [openRow, setOpenRow] = react.useState(null);
      const rows = detail.providers || [];
      if (!rows.length) return h("div", { className: "uq-empty" }, zh ? "该窗口内没有记录" : "No records in this window");
      const cur = detail.currency;
      const total = rows.reduce(function (s, r) { return s + r.tokens; }, 0) || 1;
      const showCredit = (detail.credit && detail.credit.factored > 0) || rows.some(function (r) { return r.credit && r.credit.factored > 0; });
      return h("table", { className: "uq-table" },
        h("thead", null, h("tr", null,
          h("th", null, zh ? "渠道" : "Channel"),
          h("th", { className: "num" }, withHelp("token", "tokens", L)),
          h("th", { className: "num" }, withHelp(zh ? "占比" : "share", "share", L)),
          showCredit ? h("th", { className: "num" }, withHelp(zh ? "积分当量" : "credits", "credit", L)) : null,
          h("th", { className: "num" }, zh ? "实付" : "paid"),
          h("th", { className: "num" }, withHelp(zh ? "调用" : "calls", "calls", L)))),
        h("tbody", null, rows.map(function (r) {
          const planish = r.apiCost === 0 && r.tokens > 0;
          const isOpen = openRow === r.provider;
          const models = (r.models || []).slice().sort(function (x, y) { return y.tokens - x.tokens; });
          return h(react.Fragment, { key: r.provider },
            h("tr", {
              className: "uq-clickable",
              tabIndex: 0,
              role: "button",
              "aria-expanded": isOpen ? "true" : "false",
              onClick: function () { try { beacon("row-click", "provider=" + r.provider + " isOpen=" + isOpen); } catch (x) {} setOpenRow(isOpen ? null : r.provider); },
              onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenRow(isOpen ? null : r.provider); } }
            },
              h("td", null,
                h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
                  h("span", { className: "uq-caret", "data-open": isOpen ? "1" : "0" }, models.length ? (isOpen ? "▾" : "▸") : " "),
                  channelLabel(r.provider, L),
                  planish ? h("span", { className: "uq-chip", "data-plan": "1" }, zh ? "套餐" : "plan") : null)),
              h("td", { className: "num" }, kilo(r.tokens)),
              h("td", { className: "num" }, ((r.tokens / total) * 100).toFixed(1) + "%"),
              showCredit ? h("td", { className: "num uq-credit" }, r.credit && r.credit.factored > 0 ? kilo(r.credit.factored) : "—") : null,
              h("td", { className: "num" }, money(amountOf(r, basis), cur)),
              h("td", { className: "num" }, r.calls.toLocaleString())),
            isOpen ? h("tr", { key: r.provider + "-detail" }, h("td", { colSpan: showCredit ? 6 : 5, style: { padding: 0, background: "var(--dsw-alias-bg-layer-1,#191920)" } },
              h("div", { className: "uq-subrows" }, models.map(function (m) {
                const mf = m.factor;
                return h("div", { key: m.model, className: "uq-subrow" },
                  h("span", { className: "uq-subrow-name" }, m.model || "—", mf !== null && mf !== undefined ? h("span", { className: "uq-chip" }, "×" + mf) : null, (function () { const mh = r.modelCacheHit && r.modelCacheHit[m.model]; if (!mh || mh.source === 'none') return null; const rate = mh.source === 'real' ? mh.real : mh.inferred; if (!(rate > 0)) return null; const real = mh.source === 'real'; const pct = rate * 100 >= 10 ? Math.round(rate * 100) + '%' : (rate * 100).toFixed(1) + '%'; return h("span", { "data-tip": (zh ? "该模型缓存命中率 " : "model cache hit ") + (rate * 100).toFixed(1) + '%' + (real ? (zh ? '（本渠道实测）' : ' (measured)') : (zh ? '（按同模型跨渠道反推）' : ' (inferred)')), style: { fontSize: 9, padding: '0 4px', marginLeft: 4, borderRadius: 3, color: real ? '#3fb950' : '#c9a95a', background: real ? 'rgba(63,185,80,.12)' : 'rgba(201,169,90,.12)', border: '1px solid ' + (real ? 'rgba(63,185,80,.35)' : 'rgba(201,169,90,.35)'), fontVariantNumeric: 'tabular-nums' } }, pct); })()),
                  h("span", { className: "uq-subrow-num" }, kilo(m.tokens), " tok"),
                  h("span", { className: "uq-subrow-num" }, money(amountOf(m, basis), cur)),
                  h("span", { className: "uq-subrow-num uq-dim" }, m.calls + (zh ? " 次" : "")));
              })))) : null);
        })));
    }
        function ModelTable({ detail, L, basis }) {
      basis = basis || "api";
      const rows = detail.models || [];
      if (!rows.length) return h("div", { className: "uq-empty" }, L === "zh" ? "该窗口内没有记录" : "No records in this window");
      const cur = detail.currency;
      return h("table", { className: "uq-table" },
        h("thead", null, h("tr", null,
          h("th", null, L === "zh" ? "模型" : "Model"),
          h("th", null, L === "zh" ? "渠道" : "Channels"),
          h("th", { className: "num" }, withHelp("token", "tokens", L)),
          h("th", { className: "num" }, basis === "plan" ? (L === "zh" ? "等值" : "equiv") : basis === "total" ? (L === "zh" ? "合计" : "total") : (L === "zh" ? "实付" : "paid")),
          h("th", { className: "num" }, L === "zh" ? "调用" : "calls"))),
        h("tbody", null, rows.map(function (r) {
          return h("tr", { key: r.model },
            h("td", null, r.model || "—"),
            h("td", { className: "uq-dim" }, (r.providers || []).map(function (p) { return channelLabel(p, L); }).join(" · ")),
            h("td", { className: "num" }, kilo(r.tokens)),
            h("td", { className: "num" }, money(amountOf(r, basis), cur)),
            h("td", { className: "num" }, r.calls.toLocaleString()));
        })));
    }
    function BucketTable({ detail, L }) {
      const rows = detail.buckets || [];
      if (!rows.length) return h("div", { className: "uq-empty" }, L === "zh" ? "该窗口内没有记录" : "No records in this window");
      const cur = detail.currency;
      return h("table", { className: "uq-table" },
        h("thead", null, h("tr", null,
          h("th", null, L === "zh" ? "渠道 / 模型" : "Channel / model"),
          h("th", { className: "num" }, L === "zh" ? "输入" : "input"),
          h("th", { className: "num" }, L === "zh" ? "缓存读取" : "cache"),
          h("th", { className: "num" }, L === "zh" ? "输出" : "output"),
          h("th", { className: "num" }, withHelp("token", "tokens", L)),
          h("th", { className: "num" }, L === "zh" ? "实付" : "paid"))),
        h("tbody", null, rows.map(function (r) {
          return h("tr", { key: r.provider + "|" + r.model },
            h("td", null, channelLabel(r.provider, L), h("span", { className: "uq-dim" }, " / " + (r.model || "—"))),
            h("td", { className: "num" }, kilo(r.input)),
            h("td", { className: "num" }, kilo(r.cacheRead)),
            h("td", { className: "num" }, kilo(r.output)),
            h("td", { className: "num" }, kilo(r.tokens)),
            h("td", { className: "num" }, money(r.apiCost, cur)));
        })));
    }
    function DayTable({ detail, L, basis }) {
      basis = basis || "api";
      const days = (detail.days || []).slice().reverse();
      if (!days.length) return h("div", { className: "uq-empty" }, L === "zh" ? "该窗口内没有记录" : "No records in this window");
      const cur = detail.currency;
      return h("table", { className: "uq-table" },
        h("thead", null, h("tr", null,
          h("th", null, L === "zh" ? "日期" : "Date"),
          h("th", { className: "num" }, withHelp("token", "tokens", L)),
          h("th", { className: "num" }, L === "zh" ? "实付" : "paid"),
          h("th", { className: "num" }, L === "zh" ? "等值" : "equiv"),
          h("th", { className: "num" }, L === "zh" ? "调用" : "calls"))),
        h("tbody", null, days.map(function (d) {
          return h("tr", { key: d.date },
            h("td", null, d.date),
            h("td", { className: "num" }, kilo(d.tokens)),
            h("td", { className: "num" }, money(amountOf(d, basis), cur)),
            h("td", { className: "num uq-dim" }, money(d.cost, cur)),
            h("td", { className: "num" }, d.calls.toLocaleString()));
        })));
    }
    function SessionTable({ detail, L, basis }) {
      basis = basis || "api";
      const rows = detail.sessions || [];
      if (!rows.length) return h("div", { className: "uq-empty" }, L === "zh" ? "该窗口内没有会话记录" : "No sessions in this window");
      const cur = detail.currency;
      return h("table", { className: "uq-table" },
        h("thead", null, h("tr", null,
          h("th", null, L === "zh" ? "会话" : "Session"),
          h("th", null, L === "zh" ? "日期" : "Date"),
          h("th", { className: "num" }, withHelp("token", "tokens", L)),
          h("th", { className: "num" }, L === "zh" ? "实付" : "paid"),
          h("th", { className: "num" }, L === "zh" ? "调用" : "calls"))),
        h("tbody", null, rows.map(function (r, i) {
          return h("tr", { key: r.id + "-" + i },
            h("td", null, tip(r.id, h("span", null, (r.id || "").replace(/^session-/, "").slice(0, 12)))),
            h("td", { className: "uq-dim" }, r.date),
            h("td", { className: "num" }, kilo(r.tokens)),
            h("td", { className: "num" }, money(r.apiCost, cur)),
            h("td", { className: "num" }, r.calls.toLocaleString()));
        })));
    }
    /** 金额取值：按口径在 实付 / 等值 之间选。 */
    // ⚠️ 语义（2026-11-18 修正）：
    //   apiCost = 官方价原值（"如果按量付费要多少"）
    //   cost    = apiCost × 倍率（"该渠道内的相对计价"）
    // 两者是**包含关系**（cost 由 apiCost 派生），不能相加！
    // 旧实现 total = apiCost + cost 导致双重计算（trae 68→101、官方 52→104）。
    function amountOf(row, basis) {
      const api = Number(row.apiCost) || 0;
      const cr = Number(row.cost) || 0;
      if (basis === "total") return Math.max(api, cr);   // 取大值，不相加
      if (basis === "plan") return cr;                    // 积分口径
      return api;                                          // 官方价口径
    }
    function TrendChart({ trend, basis, L, onPick, dayProviders }) {
      useCfgVersion();  // 币种/小数位改动后重渲染
      const __c2 = getCfg && getCfg();
      const cur = (__c2 && __c2.currency) || "CNY";
      if (!trend || trend.length === 0) return null;
      const zh = L === "zh";
      // 按当前口径取值；若全为 0（典型场景：只看套餐渠道，实付恒为 0），
      // 自动回退到 token 量，否则所有柱子等高、图就失去意义。
      let vals = trend.map(function (d) { return amountOf(d, basis); });
      let metric = "amount";
      if (vals.every(function (v) { return !(v > 0); })) {
        vals = trend.map(function (d) { return Number(d.tokens) || 0; });
        metric = "tokens";
      }
      const max = vals.reduce(function (m, v) { return Math.max(m, v); }, 0) || 1;
      const total = vals.reduce(function (s, v) { return s + v; }, 0);
      const peakIdx = vals.indexOf(Math.max.apply(null, vals));
      const n = trend.length;
      const barMax = 46;
      const containerStyle = n <= 3 ? { gap: "10px", justifyContent: "center" } : { gap: n <= 10 ? "6px" : "2px" };
      const barFlex = n <= 12 ? { flex: "0 1 " + barMax + "px", minWidth: "10px" } : undefined;
      // 图例：出现过的渠道按总用量降序
      const legend = (function () {
        if (!dayProviders || typeof dayProviders !== "object") return [];
        const sums = new Map();
        for (const date of Object.keys(dayProviders)) {
          const byProv = dayProviders[date] || {};
          for (const p of Object.keys(byProv)) sums.set(p, (sums.get(p) || 0) + (Number(byProv[p]) || 0));
        }
        return [...sums.entries()].sort(function (x, y) { return y[1] - x[1]; });
      })();
      return h("div", { className: "uq-trend-wrap" },
        h("div", { className: "uq-trend", style: containerStyle }, trend.map(function (d, i) {
          const v = vals[i];
          const pct = total > 0 ? (v / total) * 100 : 0;
          const byProv = (dayProviders && dayProviders[d.date]) || null;
          // 该日各渠道按用量降序；无数据时给一个占位段
          const segs = (function () {
            if (byProv === null) return [];
            const entries = Object.keys(byProv).map(function (k) { return [k, Number(byProv[k]) || 0]; })
              .filter(function (e) { return e[1] > 0; })
              .sort(function (x, y) { return y[1] - x[1]; });
            const sum = entries.reduce(function (s, e) { return s + e[1]; }, 0);
            return entries.map(function (e) { return { provider: e[0], tokens: e[1], share: sum > 0 ? e[1] / sum : 0 }; });
          })();
          const detail = segs.map(function (s) {
            return channelLabel(s.provider, L) + " " + kilo(s.tokens) + " (" + (s.share * 100).toFixed(1) + "%)";
          }).join("\n");
          const title = d.date + " · " + money(v, cur) + " · " + kilo(d.tokens) + " tok · " + d.calls + (zh ? " 次" : " calls") + " · " + pct.toFixed(1) + "%" + (detail ? "\n" + detail : "");
          // 平方根压缩比例尺：线性比例下「一个大峰值 + 一堆小值」会把小柱压成一条线
            // （实测 21 天里峰值 5.4 亿、其余几千万 ⇒ 小柱仅 1~2%）。开方后排序不变、小值可见。
            const heightPct = v <= 0 ? 2 : Math.max(6, Math.round(Math.sqrt(v / max) * 100));
          // 堆叠柱：外层定高，内部按 share 从下往上分段，每段一个渠道色
          return h("div", {
            key: d.date,
            className: "uq-bar-stack",
            "data-peak": i === peakIdx && v > 0 ? "1" : "0",
            "data-empty": v > 0 ? "0" : "1",
            "data-tip": title,
            style: Object.assign({ height: heightPct + "%" }, barFlex || {}),
            onClick: onPick ? function () { onPick(d); } : undefined
          }, segs.length === 0
            ? h("i", { className: "uq-seg-part", style: { flex: "1 1 auto", background: "#3a3a41" } })
            : segs.map(function (s, si) {
                return h("i", {
                  key: s.provider + si,
                  className: "uq-seg-part",
                  "data-tip": channelLabel(s.provider, L) + " · " + kilo(s.tokens) + " · " + (s.share * 100).toFixed(1) + "%",
                  style: { flex: String(Math.max(s.share, 0.004)) + " 0 0", background: brandColor(s.provider) }
                });
              }));
        })),
        h("div", { className: "uq-trend-axis" },
          h("span", null, trend[0].date),
          h("span", { className: "uq-sub" }, metric === "tokens" ? ((zh ? "合计 " : "total ") + kilo(vals.reduce(function (s, v) { return s + v; }, 0)) + " tok") : ((zh ? "合计 " : "total ") + money(total, cur))),
          h("span", null, trend[n - 1].date)),
        legend.length > 0 ? h("div", { className: "uq-legend" }, legend.map(function (e) {
          return h("span", { key: e[0], className: "uq-legend-item" },
            h("i", { style: { background: brandColor(e[0]) } }),
            channelLabel(e[0], L));
        })) : null);
    }
    function Composition({ comp, hitRate, L }) {
      if (!comp) return null;
      const zh = L === "zh";
      const total = comp.input + comp.output + comp.cacheRead + comp.cacheWrite;
      if (total <= 0) return null;
      const rows = [
        [zh ? "未缓存输入" : "Uncached input", comp.input],
        [zh ? "缓存读取" : "Cache read", comp.cacheRead],
        [zh ? "缓存写入" : "Cache write", comp.cacheWrite],
        [zh ? "输出" : "Output", comp.output],
      ];
      return h("div", null,
        h("div", { className: "uq-kv" }, rows.map(function (r) {
          return h(react.Fragment, { key: r[0] },
            h("span", { className: "uq-dim" }, r[0]),
            h("b", null, kilo(r[1]), " ", h("span", { className: "uq-sub" }, "(" + ((r[1] / total) * 100).toFixed(1) + "%)")));
        })),
        hitRate === null || hitRate === undefined ? null
          : h("div", { className: "uq-sub", style: { marginTop: 6 } },
            (zh ? "缓存命中率 " : "Cache hit ") + (hitRate * 100).toFixed(1) + "%"));
    }
    function RankList({ rows, basis, label, onPick, L }) {
      if (!rows || rows.length === 0) return null;
      const zh = L === "zh";
      const cur = "CNY";
      const max = rows.reduce(function (m, r) { return Math.max(m, amountOf(r, basis)); }, 0) || 1;
      return h("div", null,
        h("div", { className: "uq-h" }, h("span", null, label)),
        rows.slice(0, 12).map(function (r, i) {
          const v = amountOf(r, basis);
          const name = r.model ? r.model : channelLabel(r.provider, L);
          return h("div", { key: (r.provider || "") + "|" + (r.model || "") + i, className: "uq-row", style: { display: "block", cursor: onPick ? "pointer" : "default" },
            onClick: onPick ? function (e) { e.stopPropagation(); onPick(r); } : undefined },
            tip((zh ? "点击筛选" : "Click to filter"),
              h("div", { style: { display: "flex", justifyContent: "space-between", gap: 10 } },
                h("span", { className: "uq-l" }, name, r.provider && r.model ? h("span", { className: "uq-sub" }, " · " + channelLabel(r.provider, L)) : null),
                h("span", { className: "uq-v" }, money(v, cur)))),
            Bar(v / max, false, false));
        }));
    }
    function CallsView({ L }) {
      const [state, setState] = react.useState({ rows: null, error: null, busy: true });
      const load = react.useCallback(async function () {
        setState(function (s) { return { rows: s.rows, error: null, busy: true }; });
        try {
          const j = await fetchJson(CALLS_URL + "?limit=300");
          setState({ rows: (j && j.calls) || [], error: j && j.error, busy: false });
        } catch (e) { setState({ rows: [], error: String(e && e.message || e), busy: false }); }
      }, []);
      react.useEffect(function () { void load(); }, [load]);
      const zh = L === "zh";
      if (state.busy && !state.rows) return h("div", { className: "uq-loading" }, zh ? "读取调用记录…" : "Loading calls…");
      if (!state.rows || state.rows.length === 0) return h("div", { className: "uq-empty" }, (zh ? "没有逐次调用数据" : "No call records") + (state.error ? " · " + state.error : ""));
      return h("div", null,
        h("div", { className: "uq-h" }, h("span", null, (zh ? "最近调用" : "Recent calls") + " · " + state.rows.length),
          h("button", { className: "uq-btn", onClick: function () { void load(); } }, GlyphRefresh ? h(GlyphRefresh, { size: 12 }) : "⟳")),
        state.rows.map(function (c, i) {
          const when = c.at ? new Date(c.at).toLocaleTimeString() : "";
          return h("details", { key: i, className: "uq-call" },
            h("summary", null,
              h("span", null, when, " · ", channelLabel(c.provider, L), " / ", c.model || "—"),
              h("span", null, kilo(c.tokens), " tok")),
            h("div", { className: "uq-models", style: { marginTop: 4 } },
              h("div", { className: "uq-mrow" }, h("span", null, zh ? "未缓存输入" : "input"), h("span", null, kilo(c.input))),
              h("div", { className: "uq-mrow" }, h("span", null, zh ? "缓存读取" : "cache read"), h("span", null, kilo(c.cacheRead))),
              h("div", { className: "uq-mrow" }, h("span", null, zh ? "输出" : "output"), h("span", null, kilo(c.output))),
              c.reasoning ? h("div", { className: "uq-mrow" }, h("span", null, zh ? "推理" : "reasoning"), h("span", null, kilo(c.reasoning))) : null,
              h("div", { className: "uq-mrow" }, h("span", null, zh ? "轮次/步骤" : "turn/step"), h("span", null, c.turn + " / " + c.step))));
        }));
    }
    /** 横向额度条：粗、内联样式，带填充与轨道。 */
    /**
     * 血条：填充 = **剩余**比例（不是已用）。
     * 无上限时按「满血」显示（游戏血条语义：你看的是还剩多少）。
     * 悬停给出已用/上限/百分比/剩余，避免只有图形没有数字。
     */
    /**
     * 血条：**只用主题变量**（表面/描边/轨道都取自宿主主题），换主题会自动跟随。
     * 仅「血量语义色」用内联自定义属性 --hp-a/--hp-b（绿→红），因为它们表达的是状态而非皮肤。
     */
    /**
     * 输入框下方的额度监控（方案①：细条 + 百分比，按「剩余」）。
     * 跟随输入框当前选中的模型（modelSelection 投影）；点击展开小窗；
     * 悬停说明统一用 DSH 原生 Tooltip（tip()），跟随宿主主题。
     */
    function QuotaMini({ sessionId, L, getPick }) {
      const zh = L === "zh";
      useCfgVersion(); // 配置改动后立即重渲染（币种/小数位等影响显示）
      const __qm = getCfg && getCfg();
      const cur2 = (__qm && __qm.currency) || "CNY";
      const [data, setData] = react.useState(null);
      const [pick, setPick] = react.useState(function () { try { return getPick ? getPick() : null; } catch (e) { return null; } });
      const [open, setOpen] = react.useState(false);
      const [rect, setRect] = react.useState(null);
      const anchorRef = react.useRef(null);
      const lastKey = react.useRef("");
      // 上一轮的 token 构成（供弹层展开明细）
      const [lastTurn, setLastTurn] = react.useState(null);
      react.useEffect(function () {
        let alive = true;
        const tick = function () {
          fetch("/dsh-whale/last-turn.json?t=" + Date.now(), { credentials: "same-origin" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (alive && j && j.breakdown) setLastTurn(j); })
            .catch(function () {});
        };
        tick();
        const timer = setInterval(tick, 15000);
        return function () { alive = false; clearInterval(timer); };
      }, []);
      const load = react.useCallback(function (p) {
        const q = CURRENT_URL + "?t=" + Date.now()
          + (sessionId ? "&session=" + encodeURIComponent(sessionId) : "")
          + (p && p.provider && p.model ? "&provider=" + encodeURIComponent(p.provider) + "&model=" + encodeURIComponent(p.model) : "");
        return fetchJson(q).then(function (j) {
          setData(j);
          beacon("mini-current", "src=" + (j && j.modelSource) + " used=" + (j && j.used ? j.used.provider + "/" + j.used.model : "null"));
        }, function (e) { beacon("mini-current-err", String(e && e.message).slice(0, 100)); });
      }, [sessionId]);
      react.useEffect(function () { void load(pick); }, []);
      // 自适应轮询：正常 15 秒；触顶时 3 秒（触发限流后额度小条应尽快归零）。
      // pick 用 ref：轮询闭包是 [] 依赖，直接读 pick 会永远用初始值（导致显示旧模型/旧渠道的数据）
      const pickRef = react.useRef(pick);
      pickRef.current = pick;
      const dataRef = react.useRef(data);
      dataRef.current = data;
      react.useEffect(function () {
        let alive = true;
        let timer = null;
        const tick = function () {
          if (!alive) return;
          void load(pickRef.current).finally(function () {
            if (!alive) return;
            const cappedNow = !!(dataRef.current && dataRef.current.capped);
            timer = setTimeout(tick, cappedNow ? 3000 : 8000);
          });
        };
        timer = setTimeout(tick, 8000);
        return function () { alive = false; if (timer !== null) clearTimeout(timer); };
      }, [pick, load, data && data.capped]);
      // 轮询选中项（纯内存读取，1.5s 一次很便宜）：切换模型立即跟手
      react.useEffect(function () {
        const timer = setInterval(function () {
          let now = null;
          try { now = getPick ? getPick() : null; } catch (e) { now = null; }
          const key = now ? now.provider + "|" + now.model : "";
          if (key === lastKey.current) return;
          lastKey.current = key;
          beacon("mini-pick", key || "null");
          setPick(now);
          void load(now);
        }, 1500);
        return function () { clearInterval(timer); };
      }, [getPick, load]);
      // 弹窗跟随：窗口缩放 / 滚动时重新锚定
      react.useEffect(function () {
        if (!open) return undefined;
        const reanchor = function () { try { if (anchorRef.current) setRect(anchorRef.current.getBoundingClientRect()); } catch (err) { /* 忽略 */ } };
        reanchor();
        window.addEventListener("resize", reanchor);
        window.addEventListener("scroll", reanchor, true);
        return function () { window.removeEventListener("resize", reanchor); window.removeEventListener("scroll", reanchor, true); };
      }, [open]);
      const d = data;
      if (!d || !d.used) {
        return h("div", { style: { display: "inline-flex" } },
          tip(zh ? "额度监控已挂载，等待第一次模型调用" : "mounted, waiting for the first call",
            h("div", {
              style: { display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 6,
                border: "1px dashed var(--dsw-alias-border-l1,#3a3a41)", color: "var(--dsw-alias-label-tertiary,#8a8a93)", fontSize: 10 } },
              h("span", null, zh ? "额度" : "quota"),
              h("span", { style: { width: 62, height: 8, borderRadius: 4, border: "1px dashed var(--dsw-alias-border-l1,#3a3a41)", display: "inline-block" } }),
              h("span", null, "\u2014"))));
      }
      const limT = d.limit && d.limit.tokens ? d.limit.tokens : null;
      const remain = typeof d.remain === "number" ? d.remain : 1;
      const pct = Math.round(remain * 1000) / 10;
      const capped = d.capped === true;
      const tint = BAR_TINT(capped ? 0 : remain, capped);
      const pctText = capped ? "0%" : (pct >= 10 ? Math.round(pct) + "%" : pct.toFixed(1) + "%");
      const remainTok = limT !== null ? Math.max(0, limT - (d.today ? d.today.tokens : 0)) : null;
      const srcLabel = d.modelSource === "selected" ? (zh ? "下拉选中" : "selected") : (d.modelSource === "live" ? (zh ? "最近调用" : "last call") : (zh ? "账本推断" : "from ledger"));
      const tipText = capped
        ? (zh ? "已触顶，等待解禁" : "capped")
        : (limT !== null
          ? (zh ? "剩余 " : "left ") + pctText + " · " + kilo(remainTok) + " / " + kilo(limT) + " tok"
          : (zh ? "无上限 · 今日 " : "no cap · today ") + kilo(d.today ? d.today.tokens : 0) + " tok");
      const cm = d.creditModel || null;
      const isFreeModel = !!(cm && cm.factor === 0);
      const freeTok = d.freeTokens || 0;
      // 模型级「1 积分 ≈」：按倍率换算（与积分账单同口径）；
      // 倍率未知时退回渠道均值，并标注出来，避免"所有模型同一个数"的误解。
      const modelPerCredit = cm && cm.tokensPerCredit ? cm.tokensPerCredit : null;
      const channelPerCredit = (d.spent && d.spent > 0 && d.channelTokens) ? d.channelTokens / d.spent : null;
      const rows2 = [
        [zh ? "今日已用" : "today", kilo(d.today ? d.today.tokens : 0) + (limT !== null ? " / " + kilo(limT) : "") + " tok"],
        [zh ? "剩余" : "left", pctText + (remainTok !== null ? " · " + kilo(remainTok) + " tok" : "")],
        d.spent !== null && d.spent !== undefined ? [zh ? "今日积分" : "credits", kilo(d.spent) + (d.granted > 0 ? " \u2191" + kilo(d.granted) : "")] : null,
        isFreeModel ? [zh ? "模型倍率" : "factor", (zh ? "限时免费 ×0（不消耗积分）" : "free ×0 (no credits)")] : null,
        !isFreeModel && modelPerCredit !== null ? [zh ? "1 积分 ≈" : "1 credit approx", kilo(modelPerCredit) + " tok · ×" + (cm.factor !== null && cm.factor !== undefined ? cm.factor : "?")] : null,
        !isFreeModel && modelPerCredit === null && channelPerCredit !== null ? [zh ? "1 积分 ≈（渠道均值）" : "1 credit ~（channel avg）", kilo(channelPerCredit) + " tok"] : null,
        freeTok > 0 ? [zh ? "免费模型 token" : "free-model tokens", kilo(freeTok) + " tok（" + (zh ? "不计积分" : "not billed") + "）"] : null,
        cm && cm.baseAt1x ? [zh ? "基准 1× ≈" : "1x base ≈", kilo(cm.baseAt1x) + " tok/分"] : null,
        [zh ? "上限来源" : "limit", d.limit.source === "model" ? (zh ? "模型级" : "model") : (d.limit.source === "channel" ? (zh ? "渠道默认" : "channel") : (zh ? "未设上限" : "none"))],
        [zh ? "模型来源" : "model from", srcLabel],
        capped ? [zh ? "状态" : "state", (zh ? "已触顶 · " : "capped · ") + new Date(d.capUntil).toLocaleString("zh-CN")] : null,
        // —— 上一轮明细（token 构成 + 缓存命中率）——
        (lastTurn && lastTurn.breakdown) ? [zh ? "上轮消耗" : "last turn", (lastTurn.amount === null || lastTurn.amount === undefined) ? (lastTurn.free ? (zh ? "免费模型" : "free") : "—") : money(Number(lastTurn.amount), cur2)] : null,
        (lastTurn && lastTurn.breakdown) ? [zh ? "上轮输入" : "in", kilo(lastTurn.breakdown.input) + " tok"] : null,
        (lastTurn && lastTurn.breakdown && lastTurn.breakdown.cache !== undefined) ? [zh ? "上轮缓存命中" : "cache", kilo(lastTurn.breakdown.cache) + " tok" + (lastTurn.breakdown.hitRate !== null && lastTurn.breakdown.hitRate !== undefined ? ("（" + (lastTurn.breakdown.hitRate * 100).toFixed(1) + "%）") : "")] : null,
        (lastTurn && lastTurn.breakdown) ? [zh ? "上轮输出" : "out", kilo(lastTurn.breakdown.output) + " tok"] : null,
        (lastTurn && lastTurn.breakdown && lastTurn.breakdown.steps) ? [zh ? "上轮步数" : "steps", String(lastTurn.breakdown.steps)] : null,
        (lastTurn && lastTurn.creditBasis) ? [zh ? "计价口径" : "basis", zh ? "积分价（实际扣费）" : "credit"] : null,
      ].filter(function (x) { return x !== null; })
      // 用户反馈：「模型来源」「上限来源」这两项没什么用，移除
      .filter(function (x) { return x[0] !== (zh ? "模型来源" : "model from") && x[0] !== (zh ? "上限来源" : "limit"); });
      const panel = open && rect !== null && toPortal !== null ? toPortal(h("div", {
        style: { position: "fixed", zIndex: 2147482000, width: 336, padding: "10px 12px", borderRadius: 10,
          left: Math.max(8, Math.min(rect.right - 336, window.innerWidth - 344)),
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
          border: "1px solid var(--dsw-alias-border-l2,#4a4a53)", background: "var(--dsw-alias-bg-base,#151519)",
          color: "var(--dsw-alias-label-primary,#e6e6e6)", boxShadow: "0 18px 48px rgba(0,0,0,.5)" },
        onClick: function (e) { e.stopPropagation(); } },
        h("div", { style: { fontSize: 12, fontWeight: 600 } }, d.used.model),
        h("div", { style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary,#8a8a93)", marginBottom: 8 } },
          channelLabel(d.used.provider, L)),
        rows2.map(function (r2, idx) {
          return h("div", { key: idx, style: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, padding: "3px 0" } },
            h("span", { style: { color: "var(--dsw-alias-label-tertiary,#8a8a93)" } }, r2[0]),
            h("b", { style: { fontVariantNumeric: "tabular-nums", textAlign: "right" } }, r2[1]));
        }),
        h("div", { style: { marginTop: 6 } }, HBar({ remain: capped ? 0 : remain, label: tipText, height: 12, capped: capped })),
        h("div", { style: { marginTop: 8, display: "flex", justifyContent: "flex-end" } },
          h("button", { className: "uq-btn", onClick: function () { setOpen(false); } }, zh ? "关闭" : "Close"))), document.body) : null;
      return h("div", { style: { display: "inline-flex", alignItems: "center" } },
        tip(tipText, h("div", {
          ref: anchorRef,
          onClick: function (e) {
            e.stopPropagation();
            try { if (anchorRef.current) setRect(anchorRef.current.getBoundingClientRect()); } catch (err) { /* 忽略 */ }
            setOpen(!open);
          },
          style: { display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 6, cursor: "pointer",
            border: "1px solid " + (capped ? "rgba(176,82,82,.55)" : "var(--dsw-alias-border-l1,#3a3a41)"),
            background: "var(--dsw-alias-bg-layer-2,#1c1c21)" } },
          h("span", { style: { fontSize: 9, color: "var(--dsw-alias-label-tertiary,#8a8a93)" } }, zh ? "额度" : "quota"),
          h("div", { style: { width: 62, height: 8, borderRadius: 4, background: "var(--dsw-alias-bg-layer-3,#2a2a31)", overflow: "hidden" } },
            h("i", { style: { display: "block", height: "100%", width: (Math.max(0, Math.min(1, capped ? 0 : remain)) * 100).toFixed(1) + "%",
              borderRadius: 4, background: "linear-gradient(180deg," + tint[0] + "," + tint[1] + ")", transition: "width .35s" } })),
          h("span", { style: { fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums",
            color: capped ? "#b05252" : "var(--dsw-alias-label-secondary,#b3b3bd)" } }, pctText),
          // 今日积分直接显示在小条上，不必打开多平台明细
          (d.spent !== null && d.spent !== undefined && d.spent > 0)
            ? h("span", { style: { fontSize: 9, fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-tertiary,#8a8a93)", marginLeft: 2 } }, kilo(d.spent) + (zh ? "\u5206" : "c"))
            : null)),
        panel);
    }

    /** 宿主/客户端版本不一致时的醒目提示（避免"改了没生效"的误解）。 */
    function StaleHostBanner({ build, L }) {
      if (!build || build === CLIENT_VERSION) return null;
      const zh = L === "zh";
      return h("div", {
        style: { margin: "0 0 8px", padding: "7px 10px", borderRadius: 6, fontSize: 11,
          color: "#c9a95a", background: "rgba(201,169,90,.12)", border: "1px solid rgba(201,169,90,.45)" },
        "data-tip": CLIENT_VERSION + " / " + build },
        (zh ? "宿主端未更新（刷新只热更客户端）：请完全退出并重开 DSH。客户端 " : "Host not reloaded: restart DSH. client ")
          + CLIENT_VERSION + (zh ? " / 宿主 " : " / host ") + build);
    }
    function BAR_TINT(r, capped) {
      if (capped === true || r <= 0.1) return ["#b05252", "#8c3b3b"];
      if (r <= 0.25) return ["#c07a4a", "#9a5a33"];
      if (r <= 0.5) return ["#c9a95a", "#9a8340"];
      if (r <= 0.75) return ["#8fae70", "#5f7f4a"];
      return ["#7ba888", "#4a7a58"];
    }
    function HBar({ remain, label, height, capped }) {
      const know = remain !== null && remain !== undefined && Number.isFinite(remain);
      const r = capped === true ? 0 : (know ? Math.max(0, Math.min(1, remain)) : 1);
      const c = BAR_TINT(r, capped);
      const ticks = [];
      for (let k = 1; k <= 9; k += 1) {
        ticks.push(h("i", { key: k, className: "uq-hp-tick", style: { left: (k * 10) + "%" } }));
      }
      return h("div", {
        className: "uq-hp-frame",
        "data-tip": label || "",
        "data-capped": capped === true ? "1" : "0",
        style: { "--hp-a": c[0], "--hp-b": c[1], height: (height || 16) + 6 } },
        h("div", { className: "uq-hp-track" },
          h("i", { className: "uq-hp-fill", style: { width: (r * 100).toFixed(1) + "%" } }),
          ticks));
    }
    /** 7 天迷你柱，用于「点开模型」后的详细信息。 */
    function MiniSeries({ series, color }) {
      if (!series || series.length === 0) return null;
      const max = series.reduce(function (m, s) { return Math.max(m, s.tokens || 0); }, 0) || 1;
      return h("div", { style: { display: "flex", alignItems: "flex-end", gap: 3, height: 32, marginTop: 6 } },
        series.map(function (s) {
          return h("i", { key: s.day, "data-tip": s.day + " · " + kilo(s.tokens) + " tok",
            style: { flex: "1 1 0", minWidth: 4, height: Math.max(2, Math.round(((s.tokens || 0) / max) * 30)) + "px",
              borderRadius: "2px 2px 0 0", background: color || "#4d6bfe", opacity: (s.tokens || 0) > 0 ? 0.9 : 0.2 } });
        }));
    }
    const CHIP_ST = { fontSize: 10, border: "1px solid var(--dsw-alias-border-l1,#3a3a41)", borderRadius: 4, padding: "0 4px", color: "var(--dsw-alias-label-secondary,#b3b3bd)", flex: "none", whiteSpace: "nowrap" };
    function Dot8({ color }) { return h("i", { style: { width: 8, height: 8, borderRadius: 2, background: color, flex: "none" } }); }
    function Caret({ open }) { return h("span", { style: { fontSize: 9, display: "inline-block", width: 10, flex: "none",
      color: "var(--dsw-alias-label-tertiary,#8a8a93)", transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" } }, "\u25B8"); }
    /** 额度窗口：渠道(可折叠) -> 模型行(名称 + 额度条 + 100M/200M)，点模型看 7 天与设上限。 */
    function QuotaView({ L, zh }) {
      zh = zh === undefined ? L === "zh" : zh;
      const [state, setState] = react.useState({ data: null, error: null, busy: true });
      const [closed, setClosed] = react.useState({});
      const [openRow, setOpenRow] = react.useState(null);
      const [editing, setEditing] = react.useState(null);
      const [draft, setDraft] = react.useState("");
      const load = react.useCallback(async function (signal) {
        try {
          const j = await fetchJson(QUOTA_URL + "?t=" + Date.now());
          if (signal && signal.aborted) return;
          setState({ data: j, error: null, busy: false });
        } catch (e) { if (!(signal && signal.aborted)) setState(function (s) { return { data: s.data, error: String(e && e.message || e), busy: false }; }); }
      }, []);
      react.useEffect(function () {
        const ctl = new AbortController();
        void load(ctl.signal);
        const timer = setInterval(function () { void load(ctl.signal); }, 20000);
        return function () { clearInterval(timer); ctl.abort(); };
      }, [load]);
      const saveLimit = react.useCallback(function (provider, model, tokens) {
        const patch = {}; patch.softLimits = {};
        patch.softLimits[provider] = { tokens: 0, requests: 0, models: {} };
        patch.softLimits[provider].models[model] = { tokens: tokens, requests: 0 };
        fetch(CONFIG_URL, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(patch) })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function () { setEditing(null); void load(); })
          .catch(function () { setEditing(null); });
      }, [load]);
      const d = state.data;
      if (!d && state.busy) return h("div", { className: "uq-loading" }, zh ? "读取额度…" : "Loading…");
      if (!d) return h("div", { className: "uq-empty" }, (zh ? "读取失败：" : "Failed: ") + (state.error || ""));
      const rows = d.rows || [];
      return h("div", null,
        StaleHostBanner({ build: d.build, L: L }),
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, paddingBottom: 8 } },
          h("span", { className: "uq-sub" }, (zh ? "今日（UTC+8） " : "Today ") + (d.day || "") + (zh ? " · 20 秒自动刷新 · 点模型看详情" : "")),
          h("span", { style: { flex: 1 } }),
          h("button", { className: "uq-btn", onClick: function () { void load(); }, "data-tip": zh ? "刷新" : "Refresh" },
            state.busy ? h("span", { className: "uq-spin" }, "\u27F3") : (GlyphRefresh ? h(GlyphRefresh, { size: 12 }) : "\u27F3"))),
        rows.map(function (r) {
          const models = r.models || [];
          const isClosed = closed[r.provider] === true;
          const capped = models.some(function (m) { return m.status === "danger"; });
          const accent = brandColor(r.provider);
          return h("div", { key: r.provider, style: { marginBottom: 14 } },
            h("div", {
              "data-tip": channelLabel(r.provider, L) + " · " + (r.accounts || 0) + (zh ? " 个账号" : " acct") +
                " · " + (zh ? "今日 " : "today ") + kilo(r.today.tokens) + " tok" +
                (r.balance === null ? "" : " · " + (zh ? "余额 " : "balance ") + kilo(r.balance) + (r.unit ? " " + r.unit : "")),
              onClick: function () { const nx = Object.assign({}, closed); nx[r.provider] = !isClosed; setClosed(nx); },
              style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", cursor: "pointer",
                borderRadius: 8, background: "var(--dsw-alias-bg-layer-2,#1c1c21)",
                border: "1px solid var(--dsw-alias-border-l1,#2a2a30)" } },
              Caret({ open: !isClosed }), Dot8({ color: accent }),
              h("span", { style: { fontSize: 13, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, channelLabel(r.provider, L)),
              h("span", { className: "uq-sub" }, r.accounts + (zh ? " 号" : " acct")),
              capped ? h("span", { style: { fontSize: 10, color: "#b05252", border: "1px solid rgba(176,82,82,.5)", borderRadius: 4, padding: "0 4px", flex: "none" } }, zh ? "触顶" : "capped") : null,
              h("span", { style: { flex: 1 } }),
              h("span", { style: { fontSize: 11, whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary,#b3b3bd)", fontVariantNumeric: "tabular-nums" } },
                r.balance === null ? (zh ? "余额不可读" : "n/a") : (kilo(r.balance) + " " + (r.unit || (zh ? "积分" : "credits"))))),
            isClosed ? null : h("div", { style: { paddingTop: 4 } },
              models.length === 0 ? h("div", { className: "uq-sub", style: { padding: "4px 0 4px 18px" } }, zh ? "今日无用量" : "no usage today") : null,
              models.map(function (m) {
                const key = r.provider + "|" + m.model;
                const limT = m.limit && m.limit.tokens;
                const isOpen = openRow === key;
                const isEditing = editing === key;
                const danger = m.status === "danger";
                const warn = m.status === "warn";
                return h("div", { key: key, style: { padding: "7px 10px", margin: "5px 0 0 6px", borderRadius: 7,
                  border: "1px solid " + (m.capped === true ? "rgba(176,82,82,.38)" : "var(--dsw-alias-border-l1,#2a2a30)"),
                  borderLeft: "3px solid " + (m.capped === true ? "#b05252" : (danger ? "#b05252" : (warn ? "#bfa557" : "rgba(255,255,255,.08)"))),
                  background: m.capped === true ? "rgba(176,82,82,.06)" : "var(--dsw-alias-bg-layer-2,#1c1c21)" } },
                  h("div", { style: { display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", alignItems: "start", gap: 8, fontSize: 11, cursor: "pointer" },
                    "data-tip": m.model + "\n" + (zh ? "今日 " : "today ") + m.today.tokens + " tok · " + m.today.requests + (zh ? " 次" : " req") +
                      "\n" + (zh ? "近 7 天 " : "7d ") + m.weekTokens + " tok" +
                      (limT ? "\n" + (zh ? "上限 " : "cap ") + limT + " tok" : ""),
                    onClick: function () { setOpenRow(isOpen ? null : key); } },
                    h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.model || "\u2014"),
                    (function () {
                      const limR = m.limit && m.limit.requests;
                      const hasLim = Boolean(limT) || Boolean(limR);
                      const isCapped = m.capped === true;
                      const remain = isCapped ? 0 : (hasLim ? Math.max(0, 1 - (m.usedPct === null ? 0 : m.usedPct)) : 1);
                      const remainTok = limT ? Math.max(0, limT - m.today.tokens) : null;
                      const pctNum = remain * 100;
                      const pctText = isCapped ? "0%" : (hasLim ? (pctNum >= 10 ? Math.round(pctNum) + "%" : pctNum.toFixed(1) + "%") : "100%");
                      const leftText = isCapped ? "0" : (limT ? kilo(remainTok) : "—");
                      const warn = isCapped || (hasLim && remain <= 0.2);
                      const note = (zh ? "已用 " : "used ") + kilo(m.today.tokens)
                        + (limT ? (" / " + kilo(limT) + " tok") : " tok")
                        + (hasLim ? (" · " + (zh ? "剩余 " : "left ") + pctText + " (" + leftText + " tok)") : "")
                        + (isCapped ? (" · " + (hasLim ? (zh ? "已触顶，等待解禁" : "capped") : (zh ? "上游限流中，等待解禁" : "upstream rate-limited"))) : "");
                      const usedText = (zh ? "已用 " : "used ") + kilo(m.today.tokens) + (limT ? (" / " + kilo(limT)) : "") + " tok";
                      const right = [];
                      if (isCapped) right.push(h("span", { key: "cap", className: "uq-hp-cap", "data-tip": m.capReason || "" }, hasLim ? (zh ? "已触顶" : "capped") : (zh ? "上游限流" : "rate-limited")));
                      right.push(h("span", { key: "pct", className: "uq-hp-pct", "data-warn": warn ? "1" : "0" },
                        hasLim
                          ? (pctText + " · " + (zh ? "剩 " : "left ") + leftText + (isCapped ? "" : " tok"))
                          : (isCapped ? (zh ? "等待解禁" : "waiting") : (kilo(m.today.tokens) + " tok"))));
                      return h("div", { style: { minWidth: 0, display: "flex", flexDirection: "column", gap: 3 } },
                        HBar({ remain: remain, label: note, height: 16, capped: isCapped }),
                        h("div", { className: "uq-hp-label" },
                          h("span", { className: "uq-hp-label-left" }, usedText),
                          h("span", { className: "uq-hp-label-right" }, right)));
                    }())),
                  isOpen ? h("div", { style: { paddingLeft: 4 } },
                    MiniSeries({ series: m.series, color: accent }),
                    h("div", { className: "uq-sub", style: { display: "flex", justifyContent: "space-between", fontSize: 10 } },
                      h("span", null, (zh ? "近 7 天 " : "7d ") + kilo(m.weekTokens) + " tok"),
                      h("span", null, m.limitSource === "model" ? (zh ? "模型级上限" : "model cap") : (m.limitSource === "channel" ? (zh ? "渠道默认上限" : "channel cap") : (zh ? "未设上限" : "no cap")))),
                    h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 4 } },
                      isEditing
                        ? h(react.Fragment, null,
                            h("input", { className: "uq-input", type: "number", min: "0", step: "100000", autoFocus: true, style: { flex: 1 },
                              placeholder: zh ? "token 上限，0 = 清除" : "cap, 0 = clear", value: draft,
                              onChange: function (e) { setDraft(e.target.value); },
                              onKeyDown: function (e) { if (e.key === "Enter") saveLimit(r.provider, m.model, Math.max(0, Math.floor(Number(draft) || 0))); if (e.key === "Escape") setEditing(null); } }),
                            h("button", { className: "uq-btn", onClick: function () { saveLimit(r.provider, m.model, Math.max(0, Math.floor(Number(draft) || 0))); } }, zh ? "保存" : "Save"),
                            h("button", { className: "uq-btn", onClick: function () { setEditing(null); } }, zh ? "取消" : "Cancel"))
                        : h("button", { className: "uq-btn", onClick: function () { setEditing(key); setDraft(String(limT || "")); } }, limT ? (zh ? "改上限" : "edit cap") : (zh ? "设上限" : "set cap")))) : null);
              })));
        }));
    }
    /** 积分账单：渠道可点开看模型；不画条形图（按要求），只给数字与倍率。 */
    /** 缓存命中率小徽标：真实值绿色，反推值黄色。 */
/** React 错误边界：渲染异常时显示错误信息，而不是让整个面板消失。 */
class UqErrorBoundary extends react.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err: err }; }
  componentDidCatch(err, info) {
    try { console.error('[unified-quota]', err, info); } catch (e) {}
    try {
      const stack = String((err && (err.stack || err.message)) || err).split('\n').slice(0, 6).join(' | ');
      const comp = info && info.componentStack ? String(info.componentStack).split('\n').slice(0, 5).join(' | ') : '';
      beacon("render-error", "msg=" + String((err && err.message) || err).slice(0, 120) + " ## stack=" + stack.slice(0, 300) + " ## comp=" + comp.slice(0, 300));
    } catch (e) {}
  }
  render() {
    if (this.state.err) {
      const msg = String((this.state.err && (this.state.err.stack || this.state.err.message)) || this.state.err).slice(0, 900);
      return react.createElement('div', { style: { padding: 14, color: '#e06c75', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, '渲染出错：\n' + msg);
    }
    return this.props.children;
  }
}

function cacheBadge(c, zh) {
  try {
  const ch = c && c.cacheHit;
  if (!ch || ch.source === "none") return null;
  const rate = ch.source === "real" ? ch.real : ch.inferred;
  if (!(rate > 0)) return null;
  const real = ch.source === "real";
  const pct = rate * 100 >= 10 ? Math.round(rate * 100) + "%" : (rate * 100).toFixed(1) + "%";
  return h("span", {
    "data-tip": zh
      ? ("缓存命中率 " + (rate * 100).toFixed(1) + "%" + (real ? "（上游返回）" : "（按同模型反推）") + "\n命中比未命中便宜 50 倍")
      : "cache hit " + pct,
    style: {
      fontSize: 10, padding: "1px 5px", borderRadius: 4, marginRight: 4,
      color: real ? "#3fb950" : "#c9a95a",
      background: real ? "rgba(63,185,80,.12)" : "rgba(201,169,90,.12)",
      border: "1px solid " + (real ? "rgba(63,185,80,.4)" : "rgba(201,169,90,.4)"),
      fontVariantNumeric: "tabular-nums",
    },
  }, pct);
  } catch (e) { return null; }
}

/** 模型级缓存命中率徽标：绿=本渠道实测，黄=同模型跨渠道反推。 */
function modelCacheBadge(c, model, zh) {
  // 防护：任何异常都不能让整个面板崩掉（之前点一下面板消失，疑为渲染异常）
  try {
  const mh = c && c.modelCacheHit && c.modelCacheHit[model];
  if (!mh || mh.source === 'none') return null;
  const rate = mh.source === 'real' ? mh.real : mh.inferred;
  if (!(rate > 0)) return null;
  const real = mh.source === 'real';
  const pct = rate * 100 >= 10 ? Math.round(rate * 100) + '%' : (rate * 100).toFixed(1) + '%';
  return h('span', {
    'data-tip': zh
      ? ('该模型缓存命中率 ' + (rate * 100).toFixed(1) + '%' + (real ? '（本渠道实测）' : '（同模型跨渠道反推）') + '\n命中比未命中便宜 50 倍')
      : 'model cache hit ' + pct,
    style: {
      fontSize: 9, padding: '0 4px', borderRadius: 3, flex: 'none',
      color: real ? '#3fb950' : '#c9a95a',
      background: real ? 'rgba(63,185,80,.12)' : 'rgba(201,169,90,.12)',
      border: '1px solid ' + (real ? 'rgba(63,185,80,.35)' : 'rgba(201,169,90,.35)'),
      fontVariantNumeric: 'tabular-nums',
    },
  }, pct);
  } catch (e) { return null; }
}

/** 渠道健康：限流历史、当前冷却、解除时间。 */
const HEALTH_URL = "/api/unified-quota/channel-health";
function HealthView({ L, zh }) {
  zh = zh === undefined ? L === "zh" : zh;
  const [state, setState] = react.useState({ data: null, error: null, busy: true });
  const load = react.useCallback(function () {
    setState(function (s) { return { data: s.data, error: null, busy: true }; });
    fetchJson(HEALTH_URL + "?t=" + Date.now()).then(function (j) {
      setState({ data: j, error: null, busy: false });
    }, function (e) {
      setState({ data: null, error: String((e && e.message) || e), busy: false });
    });
  }, []);
  react.useEffect(function () { load(); }, [load]);
  react.useEffect(function () {
    const timer = setInterval(function () {
      try { if (document.visibilityState === "hidden") return; } catch (e) {}
      load();
    }, 30000);
    return function () { clearInterval(timer); };
  }, [load]);
  const d = state.data;
  if (state.error) return h("div", { className: "uq-empty" }, (zh ? "读取失败：" : "Failed: ") + state.error);
  if (!d && state.busy) return h("div", { className: "uq-loading" }, zh ? "读取渠道健康…" : "Loading…");
  const active = (d && d.active) || [];
  const activeNow = active.filter(function (a) { return a.active; });
  const byProv = (d && d.byProvider) || {};
  const provs = Object.keys(byProv).sort(function (a, b) { return byProv[b].count - byProv[a].count; });
  return h("div", null,
    h("div", { style: { display: "flex", alignItems: "center", gap: 8, paddingBottom: 8 } },
      h("span", { className: "uq-sub" }, zh
        ? ("当前 " + activeNow.length + " 个冷却中 · 历史累计 " + (d ? d.total : 0) + " 条")
        : (activeNow.length + " cooling · " + (d ? d.total : 0) + " total")),
      h("span", { style: { flex: 1 } }),
      h("button", { className: "uq-btn", onClick: load, "data-tip": zh ? "刷新" : "Refresh" }, state.busy ? "⟳" : "↻")),
    // 当前冷却
    activeNow.length > 0 ? h("div", { style: { marginBottom: 12 } },
      h("div", { className: "uq-h" }, h("span", null, zh ? "冷却中" : "Active cooldowns")),
      activeNow.map(function (a) {
        const left = Math.max(0, a.until - Date.now());
        const mins = Math.round(left / 60000);
        const txt = mins >= 60 ? (Math.floor(mins / 60) + (zh ? " 小时 " : "h ") + (mins % 60) + (zh ? " 分" : "m")) : (mins + (zh ? " 分钟" : " min"));
        return h("div", { key: a.provider + "|" + a.model, style: { display: "flex", gap: 8, alignItems: "center", fontSize: 11, padding: "6px 8px", marginBottom: 4, borderRadius: 6, border: "1px solid rgba(176,82,82,.4)", background: "rgba(176,82,82,.08)" } },
          h("b", { style: { color: "#e06c75" } }, channelLabel(a.provider, L)),
          h("span", null, a.model || "—"),
          h("span", { style: { flex: 1 } }),
          h("span", { style: { color: "#e06c75", fontVariantNumeric: "tabular-nums" } }, zh ? ("剩 " + txt) : ("left " + txt)),
          h("span", { className: "uq-sub" }, new Date(a.until).toLocaleString("zh-CN")));
      })) : h("div", { className: "uq-sub", style: { marginBottom: 12 } }, zh ? "✓ 没有渠道在冷却" : "✓ no cooldown"),
    // 按渠道统计
    provs.length > 0 ? h("div", null,
      h("div", { className: "uq-h" }, h("span", null, zh ? "历史限流统计" : "History by channel")),
      h("table", { className: "uq-table" },
        h("thead", null, h("tr", null,
          h("th", null, zh ? "渠道" : "Channel"),
          h("th", { className: "num" }, zh ? "次数" : "count"),
          h("th", { className: "num" }, zh ? "含解禁时间" : "with until"),
          h("th", null, zh ? "最近一次" : "last"),
          h("th", null, zh ? "类型" : "kinds"))),
        h("tbody", null, provs.map(function (p) {
          const s = byProv[p];
          return h("tr", { key: p },
            h("td", null, channelLabel(p, L)),
            h("td", { className: "num" }, String(s.count)),
            h("td", { className: "num" }, String(s.withUntil) + " / " + String(s.count)),
            h("td", { className: "uq-sub" }, s.lastAt ? new Date(s.lastAt).toLocaleString("zh-CN") : "—"),
            h("td", { className: "uq-sub" }, Object.entries(s.kinds || {}).map(function (kv) { return kv[0] + "×" + kv[1]; }).join(" ") || "—"));
        })))) : h("div", { className: "uq-empty" }, zh ? "还没有限流记录（触发限流后会自动记录）" : "No rate-limit records yet"),
    // 周期推断（凑够 2 次同模型限流后才出现）
    (function () {
      const periods = (d && d.periods) || [];
      if (periods.length === 0) return null;
      return h("div", { style: { marginTop: 14 } },
        h("div", { className: "uq-h" }, h("span", null, zh ? "周期推断" : "Period inference")),
        h("div", { className: "uq-sub", style: { marginBottom: 6 } },
          zh ? "同一模型反复触顶时，两次间隔若高度一致，那个间隔大概率就是真实周期。"
             : "If the gap between repeated caps is consistent, it likely equals the real period."),
        h("table", { className: "uq-table" },
          h("thead", null, h("tr", null,
            h("th", null, zh ? "模型" : "model"),
            h("th", { className: "num" }, zh ? "样本" : "samples"),
            h("th", { className: "num" }, zh ? "间隔" : "gaps"),
            h("th", { className: "num" }, zh ? "推定周期" : "period"),
            h("th", null, zh ? "可信度" : "confidence"))),
          h("tbody", null, periods.map(function (p) {
            const confColor = p.confidence === "high" ? "#3fb950" : "#c9a95a";
            const confText = p.confidence === "high" ? (zh ? "高" : "high") : (zh ? "低（需更多样本）" : "low");
            return h("tr", { key: p.provider + "|" + p.model },
              h("td", null,
                h("b", null, p.model || "—"),
                h("span", { className: "uq-sub", style: { marginLeft: 4 } }, channelLabel(p.provider, L))),
              h("td", { className: "num" }, String(p.samples)),
              h("td", { className: "num uq-sub" }, (p.gaps || []).slice(0, 3).join(" · ") || "—"),
              h("td", { className: "num", style: { fontWeight: 600, color: p.guessedMs ? "#8fa4ff" : undefined } },
                p.guessedHuman || "—"),
              h("td", { style: { color: confColor, fontSize: 11 } },
                confText + (p.consistency ? " (" + p.consistency + ")" : "")));
          }))));
    })());
}

function CreditBillView({ L, zh }) {
      zh = zh === undefined ? L === "zh" : zh;
      const [state, setState] = react.useState({ data: null, error: null, busy: true });
      const [closed, setClosed] = react.useState({});
      const load = react.useCallback(async function (days) {
        setState(function (s) { return { data: s.data, error: null, busy: true }; });
        try { const j = await fetchJson(CREDITS_URL + "?days=" + (days || 30)); setState({ data: j, error: null, busy: false }); }
        catch (e) { setState({ data: null, error: String(e && e.message || e), busy: false }); }
      }, []);
      react.useEffect(function () { void load(30); }, [load]);
      // 定时刷新：积分消耗是持续的，只在挂载时加载会导致数字"卡住不动"（用户实测停在 114）。
      // 30 秒刷新一次；页面隐藏时不刷，省资源。
      react.useEffect(function () {
        let alive = true;
        const timer = setInterval(function () {
          if (!alive) return;
          try { if (document.visibilityState === 'hidden') return; } catch (e) {}
          void load(30);
        }, 10000);
        return function () { alive = false; clearInterval(timer); };
      }, [load]);
      const d = state.data;
      if (!d && state.busy) return h("div", { className: "uq-loading" }, zh ? "读取积分账单…" : "Loading…");
      if (state.error) return h("div", { className: "uq-empty" }, (zh ? "读取失败：" : "Failed: ") + state.error);
      if (!d || d.missing) return h("div", { className: "uq-empty" }, zh ? "该时间窗内没有用量记录" : "No usage");
      const chans = d.byChannel || [];
      return h("div", null,
        StaleHostBanner({ build: d.build, L: L }),
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, paddingBottom: 6 } },
          h("span", { className: "uq-sub" }, (zh ? "近 " : "last ") + (d.sinceDays || 30) + (zh ? " 天 · 积分 = token × 倍率 · 点渠道展开" : " days")),
          h("span", { style: { flex: 1 } }),
          h("button", { className: "uq-btn", onClick: function () { void load(d.sinceDays || 30); }, "data-tip": zh ? "刷新" : "Refresh" },
            state.busy ? h("span", { className: "uq-spin" }, "\u27F3") : (GlyphRefresh ? h(GlyphRefresh, { size: 12 }) : "\u27F3"))),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 6, marginBottom: 10 } },
          [[zh ? "实扣（余额差）" : "Spent (balance delta)", d.totals.spent > 0 ? kilo(d.totals.spent) : "\u2014", "#3fb950",
             d.totals.spent > 0 ? (zh ? "今日/窗口内真实扣除的积分" : "real credits deducted") : (zh ? "需要至少两次余额读数" : "needs 2+ balance reads")],
           [zh ? "1 积分 ≈" : "1 credit ≈", d.totals.tokensPerCredit ? kilo(d.totals.tokensPerCredit) + " tok" : "\u2014", "inherit",
             zh ? "已校准渠道的 token ÷ 实扣积分" : "tokens / real credits"],
           [zh ? "token 合计" : "Tokens", kilo(d.totals.tokens), "inherit", zh ? "该窗口内所有渠道 token" : "tokens in window"],
           [zh ? "倍率（参考）" : "Factor (ref)", d.totals.known + " / " + (d.totals.known + d.totals.unknown), "inherit",
             zh ? "渠道下发的相对计价系数，不等于积分数" : "relative price factor, NOT credits"]].map(function (c, i2) {
            return h("div", { key: i2, "data-tip": c[3], style: { border: "1px solid var(--dsw-alias-border-l1,#333)", borderRadius: 8, padding: "6px 8px" } },
              h("div", { style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary,#8a8a93)" } }, c[0]),
              h("div", { style: { fontSize: 13, fontWeight: 600, marginTop: 2, fontVariantNumeric: "tabular-nums", color: c[2] } }, c[1]));
          })),        chans.map(function (c) {
          const models = c.models || [];
          const isClosed = closed[c.provider] === true;
          const accent = brandColor(c.provider);
          const ft = c.mixedFactor ? ((zh ? "混合×" : "mix×") + (Math.round(c.factor * 100) / 100)) : (c.factor === null || c.factor === undefined ? null : "\u00D7" + c.factor);
          return h("div", { key: c.provider, style: { marginBottom: 8 } },
            h("div", {
              "data-tip": channelLabel(c.provider, L) + "\n" + (zh ? "实扣 " : "spent ") + c.spent + "\n" + (zh ? "同窗口 token " : "tokens ") + (c.tokensInSpan === null || c.tokensInSpan === undefined ? "\u2014" : c.tokensInSpan) +
                (c.baseAt1x ? "\n" + (zh ? "基准 1× ≈ " : "1x ≈ ") + Math.round(c.baseAt1x) + " tok/分" : "") + (c.cacheHit && c.cacheHit.source !== "none" ? "\n" + (zh ? "缓存命中率 " : "cache hit ") + ((c.cacheHit.source === "real" ? c.cacheHit.real : c.cacheHit.inferred) * 100).toFixed(1) + "%" + (c.cacheHit.source === "inferred" ? (zh ? "（按同模型反推）" : " (inferred)") : "") : ""),
              onClick: function () { const nx = Object.assign({}, closed); nx[c.provider] = !isClosed; setClosed(nx); },
              style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", cursor: "pointer", borderRadius: 8,
                background: "var(--dsw-alias-bg-layer-2,#1c1c21)", border: "1px solid var(--dsw-alias-border-l1,#2a2a30)" } },
              Caret({ open: !isClosed }), Dot8({ color: accent }),
              h("span", { style: { fontSize: 13, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, channelLabel(c.provider, L)),
              ft ? h("span", { style: CHIP_ST }, ft) : null,
              h("span", { style: { flex: 1 } }),
              cacheBadge(c, zh),
              h("span", { style: { fontSize: 11, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" } },
                c.spent > 0 ? h("b", { style: { color: "#3fb950" } }, kilo(c.spent)) : h("span", { className: "uq-sub" }, "\u2014"),
                c.granted > 0 ? h("span", { style: { color: "#7f9e63", marginLeft: 4 }, "data-tip": zh ? "签到/充值带来的增加，不算消耗" : "grants (check-in / top-up), not spending" },
                  (zh ? " \u2191" : " +") + kilo(c.granted)) : null,
                h("span", { className: "uq-sub" }, (zh ? " 分" : " cr")),
                // 渠道级常驻基准：1 倍率时 1 积分 ≈ 多少 token
                c.baseAt1x !== null && c.baseAt1x !== undefined
                  ? h("span", { style: { marginLeft: 8, paddingLeft: 8, borderLeft: "1px solid var(--dsw-alias-border-l1,#2a2a30)",
                      color: "#8fa4ff" }, "data-tip": zh ? "渠道基准：假设 积分 = token × 倍率 × k，用实扣反推 k；模型级再把基准除以各自倍率。样本越多越准。" : "channel baseline at 1x" },
                      "1\u00D7 \u2248 " + kilo(c.baseAt1x) + " tok/分")
                  : null)),
            isClosed ? null : h("div", { style: { paddingTop: 3 } },
              models.map(function (m) {
                const mk = c.provider + "|" + m.model;
                return h("div", { key: mk,
                  "data-tip": m.model + "\n" + (zh ? "token " : "tokens ") + m.tokens +
                    "\n" + (zh ? "token " : "tokens ") + m.tokens + "\n" + (zh ? "调用 " : "calls ") + m.requests +
                    (m.factor === null ? "\n" + (zh ? "该模型无倍率标注" : "no factor") : "\n" + (zh ? "倍率 " : "factor ") + "x" + m.factor),
                  style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11, padding: "6px 10px", margin: "4px 0 0 6px",
                    cursor: "default", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1,#26262c)",
                    background: "var(--dsw-alias-bg-layer-2,#1c1c21)" } },
                  h("span", { style: { minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.model || "\u2014"),
                  modelCacheBadge(c, m.model, zh),
                  m.factor === null || m.factor === undefined ? null
                    : (m.factor === 0 ? h("span", { style: Object.assign({}, CHIP_ST, { color: "#7f9e63", borderColor: "rgba(127,158,99,.5)" }) }, zh ? "限时免费" : "free")
                      : h("span", { style: CHIP_ST }, "\u00D7" + m.factor)),
                  h("span", { style: { whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" } },
                    h("b", null, kilo(m.tokens)), h("span", { className: "uq-sub" }, " tok"),
                    m.factor === null || m.factor === undefined ? null
                      : h("span", { className: "uq-sub", "data-tip": zh ? "渠道下发的相对计价系数" : "relative price factor" }, " · ×" + m.factor),
                    m.estTokensPerCredit !== null && m.estTokensPerCredit !== undefined
                      ? h("span", { style: { marginLeft: 8, color: "#8fa4ff" },
                          "data-tip": zh ? "按渠道基准 ÷ 该模型倍率估算；样本累积后自动变准" : "estimated = baseline / factor" },
                          "≈ " + kilo(m.estTokensPerCredit) + " tok/分") : null));
              })));
        }));
    }
    function DetailSheetInner({ L, onClose: rawOnClose }) {
  useCfgVersion();  // 币种改动后重渲染
      // 调用栈追踪：每次 onClose 被调用都记录（区分 Escape / 遮罩 / 外部）
      const onClose = function (why) {
        try {
          // 识别调用来源：React 事件对象有 type/target
          let info = "noarg";
          if (why && typeof why === "object") {
            info = "event type=" + (why.type || "?") + " target=" + String((why.target && (why.target.className || why.target.tagName)) || "?").slice(0, 40)
              + " curTarget=" + String((why.currentTarget && (why.currentTarget.className || why.currentTarget.tagName)) || "?").slice(0, 40);
          } else if (why) { info = "str=" + String(why).slice(0, 40); }
          const st = String(new Error().stack || "").split("\n").slice(1, 7)
            .map(function (l) { const m = /(client\.js[^)]*|at [\w$.]+ )/.exec(l); return (m ? m[0] : l.trim()).slice(0, 60); }).join(" | ");
          beacon("sheet-close-call", info + " ## " + st);
        } catch (x) {}
        rawOnClose();
      };
      ensureCss();
      // 探针：确认 DetailSheet 是否真的挂载了
      const __sid = react.useRef(null);
      if (__sid.current === null) __sid.current = "s" + Math.random().toString(36).slice(2, 7);
      try { beacon("sheet-mount", "id=" + __sid.current + " L=" + L); } catch (x) {}
      react.useEffect(function () { try { beacon("sheet-mounted", "ok"); } catch (x) {} return function () { try { beacon("sheet-unmount", "id=" + __sid.current + " panelOpen=" + __uqPanelOpen); } catch (x) {} }; }, []);
      const zh = L === "zh";
      const [win, setWin] = react.useState(function () {
        const g = getCfg && getCfg();
        const v = g && Number(g.detailWindow);
        return (v === 7 || v === 30 || v === 90) ? v : 30;
      });
      // 细分页签（按渠道/按模型/按日/按会话）：用独立字段 detailSubTab，
      // ⚠️ 不能与顶部页签共用 detailTab —— 否则 detailTab="credits" 时
      //    这里的白名单不认，会落入兜底分支显示「逐次调用」。
      const [tab, setTabRaw] = react.useState(function () {
        // 先用 localStorage 同步缓存（消闪），再由 config 校正
        try {
          const c = localStorage.getItem("uq-detail-subtab");
          if (c === "provider" || c === "model" || c === "day" || c === "session" || c === "call") return c;
        } catch (e) {}
        const g = getCfg && getCfg();
        const v = g && g.detailSubTab;
        return (v === "provider" || v === "model" || v === "day" || v === "session" || v === "call") ? v : "provider";
      });
      const setTab = function (v) {
        setTabRaw(v);
        try {
          localStorage.setItem("uq-detail-subtab", v);
          fetch(CONFIG_URL, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ detailSubTab: v }) }).catch(function () {});
        } catch (e) {}
      };
      const [basis, setBasis] = react.useState(function () {
        const g = getCfg && getCfg();
        const v = g && g.statisticsBasis;
        return (v === "api" || v === "total" || v === "plan") ? v : "api";
      });
      const [fProvider, setFProvider] = react.useState("");
      const [fModel, setFModel] = react.useState("");
      const [showAdv, setShowAdv] = react.useState(false);
      // 顶部两个入口（截图红框位置）：点开后在正文区展示更细的模型级视图
      // 页签（多平台明细/积分账单/额度窗口/渠道健康）：持久化到 config.detailTab
      // ⚠️ 关键：getCfg() 依赖 sharedCfg，而后者只在「设置页 useConfig() 挂载过」之后才有值。
      //    明细页可能先于设置页打开 ⇒ getCfg() 初始为 null ⇒ 页签永远是默认。
      //    这里主动拉一次配置，拉到后 setPanel 到持久化的值。
      // 页签初值：先用 localStorage 的同步缓存（消除"先闪多平台明细"），
      // 再用后端 config 校正（跨设备/重装后依然正确）。
      const [panel, setPanelRaw] = react.useState(function () {
        try {
          const v = localStorage.getItem("uq-detail-panel");
          return (v === "credits" || v === "quota" || v === "health") ? v : null;
        } catch (e) { return null; }
      });
      const cfgApplied = react.useRef(false);
      react.useEffect(function () {
        if (cfgApplied.current) return;
        cfgApplied.current = true;
        fetchJson(CONFIG_URL).then(function (j) {
          const g = j && j.config;
          if (!g) return;
          setSharedCfg(g);
          const v = g.detailTab;
          if (v === "credits" || v === "quota" || v === "health") {
            setPanelRaw(v);
            try { localStorage.setItem("uq-detail-panel", v); } catch (e) {}
          } else {
            setPanelRaw(null);
            try { localStorage.setItem("uq-detail-panel", "table"); } catch (e) {}
          }
          // 细分页签也要从 config 校正（localStorage 只是初值）
          const sub = g.detailSubTab;
          if (sub === "provider" || sub === "model" || sub === "day" || sub === "session" || sub === "call") {
            setTabRaw(sub);
            try { localStorage.setItem("uq-detail-subtab", sub); } catch (e) {}
          }
        }).catch(function () {});
      }, []);
      const setPanel = function (v) {
        setPanelRaw(v);
        try {
          const store = (v === null || v === "table") ? "table" : v;
          localStorage.setItem("uq-detail-panel", store);
          fetch(CONFIG_URL, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ detailTab: store }) }).catch(function () {});
        } catch (e) {}
      };
      // 窗口尺寸：1=默认；<1 缩小；持久化到 localStorage，下次打开沿用
      const [sizeMode, setSizeMode] = react.useState(function () {
        try { const v = Number(localStorage.getItem("uq-dlg-size")); return v > 0.4 && v <= 1 ? v : 1; } catch (e) { return 1; }
      });
      // 窗口位置：拖标题栏移动；持久化，下次沿用。null = 居中
      const [pos, setPos] = react.useState(function () {
        try { const raw = localStorage.getItem("uq-dlg-pos"); if (!raw) return null; const o = JSON.parse(raw); return (Number.isFinite(o.x) && Number.isFinite(o.y)) ? o : null; } catch (e) { return null; }
      });
      // 尺寸记忆：除了预设档位，还要记住用户**手动拖拽缩放**后的真实大小
      const dlgRef = react.useRef(null);
      const [box, setBox] = react.useState(function () {
        try {
          const raw = localStorage.getItem("uq-dlg-box");
          if (!raw) return null;
          const o = JSON.parse(raw);
          return (o && Number(o.w) >= 420 && Number(o.h) >= 320) ? { w: Math.round(o.w), h: Math.round(o.h) } : null;
        } catch (e) { return null; }
      });
      react.useEffect(function () {
        const el = dlgRef.current;
        if (!el || typeof ResizeObserver !== "function") return undefined;
        let timer = null;
        const persist = function () {
          try {
            const r = el.getBoundingClientRect();
            if (r.width >= 420 && r.height >= 320) localStorage.setItem("uq-dlg-box", JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
          } catch (e) { /* 忽略 */ }
        };
        const ro = new ResizeObserver(function () { if (timer) clearTimeout(timer); timer = setTimeout(persist, 250); });
        try { ro.observe(el); } catch (e) { /* 忽略 */ }
        return function () { if (timer) clearTimeout(timer); persist(); try { ro.disconnect(); } catch (e) { /* 忽略 */ } };
      }, []);
      const dragRef = react.useRef(null);
      const onDragStart = react.useCallback(function (e) {
        if (e.button !== 0) return;
        const t = e.target;
        // 只在标题栏空白处起拖，别抢按钮的点击
        if (t && (t.closest && t.closest("button,select,input,a,.uq-seg2"))) return;
        const box = e.currentTarget.parentElement;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, w: rect.width, h: rect.height };
        e.preventDefault();
      }, []);
      react.useEffect(function () {
        const onMove = function (e) {
          const d = dragRef.current;
          if (!d) return;
          const x = Math.min(Math.max(0, e.clientX - d.dx), Math.max(0, window.innerWidth - 120));
          const y = Math.min(Math.max(0, e.clientY - d.dy), Math.max(0, window.innerHeight - 60));
          setPos({ x: x, y: y });
        };
        const onUp = function () {
          if (dragRef.current) {
            dragRef.current = null;
            setPos(function (p) { try { if (p) localStorage.setItem("uq-dlg-pos", JSON.stringify(p)); } catch (e) {} return p; });
          }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return function () {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
      }, []);
      react.useEffect(function () { try { localStorage.setItem("uq-dlg-size", String(sizeMode)); } catch (e) {} }, [sizeMode]);
      const opts = react.useMemo(function () { return { window: win, provider: fProvider, model: fModel }; }, [win, fProvider, fModel]);
      const d = useDetail(true, opts);
      const det = d.state.data;
      const cur = det ? det.currency : "CNY";
      // ⚠️ deps 原来是 [onClose]，内联 onClose 每次渲染都是新引用 ⇒ 每次渲染都重绑监听。
      // 且闭包可能持有过期 state。改为 ref + []，只绑一次。
      const __onCloseRef = react.useRef(onClose);
      __onCloseRef.current = onClose;
      react.useEffect(function () {
        const onKey = function (e) {
          try { beacon("sheet-escape", "key=" + e.key); } catch (x) {}
          if (e.key === "Escape") __onCloseRef.current();
        };
        document.addEventListener("keydown", onKey);
        return function () { document.removeEventListener("keydown", onKey); };
      }, []);
      const TABS = [["provider", zh ? "渠道" : "Channel"], ["model", zh ? "模型" : "Model"], ["day", zh ? "日期" : "Day"], ["session", zh ? "会话" : "Session"], ["call", zh ? "逐次调用" : "Calls"]];
      const BASIS = [["api", zh ? "实付" : "Paid"], ["total", zh ? "合计" : "Total"], ["plan", zh ? "等值" : "Equiv"]];
      const skeleton = h("div", null, h("div", { className: "uq-skel", style: { width: "60%" } }), h("div", { className: "uq-skel" }),
        h("div", { className: "uq-skel", style: { width: "80%" } }), h("div", { className: "uq-skel", style: { width: "45%" } }));
      // 积分账单 / 额度窗口的数据源独立，不依赖 det；放最前面避免被骨架屏挡住
      const body = panel === "credits" ? h(UqErrorBoundary, null, h(CreditBillView, { L: L, zh: zh }))
        : panel === "health" ? h(UqErrorBoundary, null, h(HealthView, { L: L, zh: zh }))
        : panel === "quota" ? h(QuotaView, { L: L, zh: zh })
        : !det
        ? (d.state.error ? h("div", { className: "uq-empty" }, (zh ? "读取失败：" : "Failed: ") + d.state.error) : skeleton)
        : (tab === "provider" ? h("div", null,
              h(ProviderTable, { detail: det, L: L, basis: basis }),
              showAdv ? h("div", { style: { marginTop: 14 } },
                (!getCfg() || getCfg().showComposition !== false) ? h("div", null,
                  h("div", { className: "uq-h" }, h("span", null, zh ? "Token 构成与缓存" : "Token mix & cache")),
                  h(Composition, { comp: det.composition, hitRate: det.hitRate, L: L })) : null) : null)
          : tab === "model" ? h("div", null, h(ModelTable, { detail: det, L: L, basis: basis }))
          : tab === "day" ? h("div", null, h(DayTable, { detail: det, L: L, basis: basis }))
          : tab === "session" ? h(SessionTable, { detail: det, L: L, basis: basis })
          : tab === "call" ? h(CallsView, { L: L })
          : h(ProviderTable, { detail: det, L: L, basis: basis }));
      const pickProvider = function (row) { try { beacon("pick-provider", String(row && row.provider)); } catch (x) {} setFProvider(row.provider || ""); setFModel(""); setTab("provider"); };
      const pickModel = function (row) {
        try { beacon("pick-model", String(row && row.model)); } catch (x) {}
        // 保留渠道筛选（原来 setFProvider("") 清掉渠道，无法筛「某渠道下的某模型」）
        setFModel(row.model || "");
        setTab("provider");
      };
      // 遮罩要截断指针事件：宿主的全局监听不该收到弹层内的点击（穿透的根本原因之一）
      const swallow = react.useCallback(function (e) { e.stopPropagation(); }, []);
      // 零尺寸定位锚：不再铺满屏幕，DSH 本体可以正常操作（非模态浮窗）
      const anchorProps = {
        className: "uq-anchor",
        style: { position: "fixed", left: 0, top: 0, width: 0, height: 0, zIndex: 2147482000, pointerEvents: "none" },
      };
      // 浮窗状态：最大化 / 最小化（收起成小条）
      const [maxed, setMaxed] = react.useState(false);
      const [mins, setMins] = react.useState(false);
      const panelW = box !== null ? box.w : 980;
      const panelH = box !== null ? box.h : 720;
      const panelStyle = maxed
        ? { position: "fixed", left: 8, top: 8, width: "calc(100vw - 16px)", height: "calc(100vh - 16px)", margin: 0, resize: "none", pointerEvents: "auto" }
        : (pos !== null
          ? { position: "fixed", left: pos.x + "px", top: pos.y + "px", width: "min(" + panelW + "px, calc(100vw - 16px))", height: "min(" + panelH + "px, calc(100vh - 16px))", margin: 0, resize: "both", pointerEvents: "auto" }
          : { position: "fixed", left: "calc(50vw - " + Math.round(panelW / 2) + "px)", top: "calc(50vh - " + Math.round(panelH / 2) + "px)", width: "min(" + panelW + "px, calc(100vw - 16px))", height: "min(" + panelH + "px, calc(100vh - 16px))", margin: 0, resize: "both", pointerEvents: "auto" });
      const filtered = fProvider !== "" || fModel !== "";
      // 最小化：收起成右下角小条，点它还原（不占屏幕、不挡 DSH）
      if (mins === true) {
        return h("div", {
          className: "uq-minipill",
          style: { position: "fixed", right: 18, bottom: 18, zIndex: 2147482000, display: "flex", alignItems: "center", gap: 8,
            padding: "8px 12px", borderRadius: 999, cursor: "pointer",
            background: "var(--dsw-alias-bg-layer-2,#1c1c21)", border: "1px solid var(--dsw-alias-border-l2,#4a4a53)",
            boxShadow: "0 12px 32px rgba(0,0,0,.45)" },
          "data-tip": zh ? "点按还原窗口" : "Restore window",
          onClick: function () { setMins(false); } },
          h("span", { style: { fontSize: 12, fontWeight: 600 } }, zh ? "额度中心" : "Quota"),
          det ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary,#8a8a93)" } }, kilo(det.totals.tokens) + " tok") : null,
          h("span", { style: { fontSize: 11, color: "#7f9e63" } }, zh ? "还原" : "restore"));
      }
      return h("div", anchorProps,
        h("div", {
            className: "uq-dlg",
            ref: dlgRef,
            style: panelStyle,
            onClick: function (e) { e.stopPropagation(); },
            onMouseDownCapture: function (e) {
              try {
                const t = e.target || {};
                const r0 = t.getBoundingClientRect ? t.getBoundingClientRect() : null;
                beacon("dlg-down", "tag=" + (t.tagName || "?") + " cls=" + String(t.className || "").slice(0, 50)
                  + " pt=" + Math.round(e.clientX) + "," + Math.round(e.clientY)
                  + (r0 ? " el=" + Math.round(r0.left) + "," + Math.round(r0.top) + " " + Math.round(r0.width) + "x" + Math.round(r0.height) : ""));
              } catch (x) {}
            }
          },
          // 标题行
          h("div", { className: "uq-dlg-top", onMouseDown: onDragStart },
            h("div", { style: { minWidth: 0, display: "flex", alignItems: "center", gap: 10 } },
              h("div", { style: { minWidth: 0, display: "flex", flexDirection: "column", gap: 2 } },
                h("span", { className: "uq-seg2" },
                  [["table", zh ? "多平台明细" : "Details"], ["credits", zh ? "积分账单" : "Credits"], ["quota", zh ? "额度窗口" : "Quota"], ["health", zh ? "渠道健康" : "Health"]].map(function (o) {
                    const on = (o[0] === "table" && panel === null) || panel === o[0];
                    return h("button", { key: o[0], "data-on": on ? "1" : "0", onClick: function () { setPanel(o[0] === "table" ? null : o[0]); }, style: { fontSize: 12, fontWeight: on ? 600 : 500, padding: "5px 12px" } }, o[1]);
                  })),
                det ? h("div", { className: "uq-sub" }, det.days.length + (zh ? " 天 · " : " days · ") + kilo(det.totals.tokens) + " tok · " + money(amountOf(det.totals, basis), cur)) : null)),
            h("span", { style: { display: "inline-flex", gap: 4, alignItems: "center" } },
              h("span", { style: { display: "inline-flex", gap: 2, marginRight: 4 } },
                h("button", { className: "uq-winbtn", "data-tip": zh ? "最小化" : "Minimize", onClick: function () { setMins(true); } }, "\u2013"),
                h("button", { className: "uq-winbtn", "data-tip": zh ? (maxed ? "还原" : "最大化") : (maxed ? "Restore" : "Maximize"), onClick: function () { setMaxed(!maxed); } }, maxed ? "\u2750" : "\u25A1"),
                h("button", { className: "uq-winbtn uq-winbtn-close", "data-tip": zh ? "关闭" : "Close", onClick: onClose }, "\u00D7")),
              h("button", { className: "uq-btn", "data-tip": zh ? "导出 CSV" : "Export CSV", onClick: function () {
                try { window.open(EXPORT_URL + "?window=" + win + "&provider=" + encodeURIComponent(fProvider) + "&model=" + encodeURIComponent(fModel), "_blank"); } catch (e) {}
              } }, "⤓"),
              h("button", { className: "uq-btn", "data-tip": dict[L].refresh, onClick: function () { void d.reload(Object.assign({}, opts, { refreshFactors: true })); } }, GlyphRefresh ? h(GlyphRefresh, { size: 13 }) : "⟳"))),
          // 工具栏：时间 / 口径 / 筛选
          panel !== null ? null : h("div", { className: "uq-toolbar" },
            h("span", { className: "uq-lab" }, zh ? "时间" : "Range"),
            h("div", { className: "uq-seg2" }, [[7, "7"], [30, "30"], [90, "90"]].map(function (w) {
              return h("button", { key: w[0], "data-on": win === w[0] ? "1" : "0", onClick: function () { setWin(w[0]); } }, w[1] + (zh ? " 天" : "d"));
            })),
            h("span", { className: "uq-toolbar-sp" }),
            h("span", { className: "uq-lab" }, zh ? "口径" : "Basis"),
            h("div", { className: "uq-seg2" }, BASIS.map(function (b) {
              return h("button", { key: b[0], "data-on": basis === b[0] ? "1" : "0", onClick: function () { setBasis(b[0]); } }, b[1]);
            }))),
          panel === null && det && (det.options.providers.length > 1 || det.options.models.length > 1 || filtered) ? h("div", { className: "uq-toolbar", style: { paddingTop: 0 } },
            h("span", { className: "uq-lab" }, zh ? "筛选" : "Filter"),
            (function () {
              // 双向联动筛选：选渠道后只列该渠道有的模型；选模型后只列有该模型的渠道。
              // 数据来自 det.models[].providers / det.providers[].models（后端已提供交集）。
              // ⚠️ 必须用 options 里的「全量」交集映射。
              // det.models / det.providers 是被当前筛选裁剪过的（选 qodercn 后只剩 3 个模型），
              // 用它做联动会导致「选定后无法切到其它模型」。
              const modelToProvs = {};
              for (const [m, ps] of Object.entries(det.options.modelToProvs || {})) modelToProvs[m] = new Set(ps);
              const provToModels = {};
              for (const [p, ms] of Object.entries(det.options.provToModels || {})) provToModels[p] = new Set(ms);
              const provsShown = (fModel.length > 0 && modelToProvs[fModel])
                ? det.options.providers.filter(function (p) { return modelToProvs[fModel].has(p); })
                : det.options.providers;
              const modelsShown = (fProvider.length > 0 && provToModels[fProvider])
                ? det.options.models.filter(function (m) { return provToModels[fProvider].has(m); })
                : det.options.models;
              return h(react.Fragment, null,
                det.options.providers.length > 1 ? h("select", { className: "uq-select", value: fProvider,
                  onChange: function (e) {
                    const v = e.target.value;
                    setFProvider(v);
                    // 若当前模型不属于新渠道，清掉模型
                    if (v && fModel && !(modelToProvs[fModel] && modelToProvs[fModel].has(v))) setFModel("");
                  } },
                  h("option", { value: "" }, zh ? "全部渠道" : "All channels"),
                  provsShown.map(function (p) { return h("option", { key: p, value: p }, channelLabel(p, L)); })) : null,
                det.options.models.length > 1 ? h("select", { className: "uq-select", value: fModel,
                  onChange: function (e) {
                    const v = e.target.value;
                    setFModel(v);
                    if (v && fProvider && !(provToModels[fProvider] && provToModels[fProvider].has(v))) setFProvider("");
                  } },
                  h("option", { value: "" }, zh ? "全部模型" : "All models"),
                  modelsShown.map(function (m) { return h("option", { key: m, value: m }, m || "—"); })) : null);
            })(),
            filtered ? h("button", { className: "uq-btn", onClick: function () { setFProvider(""); setFModel(""); } }, "✕ " + (zh ? "清除" : "clear")) : null,
            h("span", { className: "uq-toolbar-sp" }),
            h("button", { className: "uq-btn", onClick: function () { setShowAdv(!showAdv); } }, showAdv ? (zh ? "收起分析" : "Less") : (zh ? "分析" : "Analyse"))) : null,
          // 趋势 + 分析
          panel === null && (!getCfg() || getCfg().showTrend !== false) && det && det.trend && det.trend.length > 0 ? h("div", { style: { padding: "0 16px" } },
            filtered ? h("div", { className: "uq-filterbar" },
              h("span", { className: "uq-chip", "data-plan": "1" }, zh ? "已筛选" : "filtered"),
              h("span", { className: "uq-sub" }, (fProvider ? channelLabel(fProvider, L) : fModel) + (zh ? " · " : " · ") + det.days.length + (zh ? " 天有数据" : " days")),
              h("button", { className: "uq-btn", onClick: function () { setFProvider(""); setFModel(""); } }, "✕ " + (zh ? "看全部" : "all"))) : null,
            h(TrendChart, { trend: det.trend, basis: basis, L: L, dayProviders: det.dayProviders })) : null,
          panel === null && showAdv && det ? h("div", { style: { padding: "0 16px 4px" } },
            h("div", { className: "uq-card" },
              h("div", { className: "uq-h" }, h("span", null, zh ? "模型排行 · 点击筛选" : "Top models · click to filter")),
              h(RankList, { rows: det.models, basis: basis, label: "", onPick: pickModel, L: L }),
              h("div", { className: "uq-h", style: { marginTop: 10 } }, h("span", null, zh ? "渠道排行 · 点击筛选" : "Top channels · click to filter")),
              h(RankList, { rows: det.providers, basis: basis, label: "", onPick: pickProvider, L: L }))) : null,
          // 积分当量摘要
          panel === null && det && det.credit && det.credit.factored > 0 ? h("div", { style: { padding: "0 16px" } },
            h("div", { className: "uq-stats", style: { marginBottom: 6 } },
              h("div", null, h("div", { className: "k" }, withHelp(zh ? "积分当量" : "Credit equiv", "credit", L)), h("div", { className: "v uq-credit" }, kilo(det.credit.factored))),
              h("div", null, h("div", { className: "k" }, withHelp(zh ? "已知倍率模型" : "Known factors", "factor", L)), h("div", { className: "v" }, det.credit.known)),
              h("div", null, h("div", { className: "k" }, withHelp(zh ? "未知倍率" : "Unknown", "unknownFactor", L)), h("div", { className: "v" }, det.credit.unknown)),
              h("div", null,
                h("div", { className: "k" }, withHelp(zh ? "倍率同步" : "Factor sync", "factor", L)),
                h("div", { className: "v", style: { fontSize: 12 } },
                  det.factorsAt ? (function () {
                    const mins = Math.max(0, Math.round((Date.now() - det.factorsAt) / 60000));
                    return mins < 1 ? (zh ? "刚刚" : "just now") : mins + (zh ? " 分钟前" : " min ago");
                  })() : (zh ? "未同步" : "n/a"))))) : null,
          // 主标签
          panel === null ? h("div", { className: "uq-tabs" }, TABS.map(function (t) {
            return h("button", { key: t[0], className: "uq-tab", "data-on": tab === t[0] ? "1" : "0", onClick: function () { setTab(t[0]); } }, t[1]);
          })) : null,
          h("div", { className: "uq-body" }, h(UqErrorBoundary, null, body)),
          h("div", { className: "uq-footer" },
            h("span", { className: "uq-footer-info" },
              det ? (det.days.length + (zh ? " 天 · " : " days · ") + kilo(det.totals.tokens) + " tok · " + det.totals.calls + (zh ? " 次调用" : " calls")) : (zh ? "加载中…" : "Loading…")),
            h("span", { className: "uq-footer-actions" },
              h("button", { className: "uq-btn", onClick: onClose, "data-tip": zh ? "关闭（Esc）" : "Close (Esc)" }, zh ? "关闭" : "Close")))));
    }
    function DetailSheet(props) {
      const zh = props.L === "zh";
      try {
        return h(DetailSheetInner, props);
      } catch (failure) {
        try { beacon("detail-render-throw", String(failure && failure.message || failure)); } catch (e) {}
        return h("div", { className: "uq-sheet", onClick: props.onClose },
          h("div", { className: "uq-dlg", onClick: function (e) { e.stopPropagation(); } },
            h("div", { className: "uq-dlg-top" },
              h("strong", null, zh ? "明细页渲染出错" : "Detail view error"),
              h("button", { className: "uq-btn", onClick: props.onClose }, "\u00D7")),
            h("div", { className: "uq-body" },
              h("div", { className: "uq-err", style: { whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 11 } },
                String((failure && (failure.stack || failure.message)) || failure).slice(0, 1500)))));
      }
    }
    //#endregion
    //#region mount
    function UnifiedQuotaCard() {
      ensureCss();
      const L = locale();
      const st = useCore();
      const [open, setOpen] = react.useState(false);
      const [detail, setDetail] = react.useState(false);
      const [pos, setPos] = react.useState({ top: 0, left: 0 });
      const anchor = react.useRef(null);
      react.useEffect(function () {
        if (!open) return;
        const onKey = function (e) { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("keydown", onKey);
        return function () { document.removeEventListener("keydown", onKey); };
      }, [open]);
      const toggle = react.useCallback(function () {
        if (!open && anchor.current) {
          const r = anchor.current.getBoundingClientRect();
          const wPop = Math.min(380, (window.innerWidth || 800) - 24);
          const left = Math.max(12, Math.min(r.left, (window.innerWidth || 800) - wPop - 12));
          const estH = Math.min((window.innerHeight || 800) * 0.72, 520);
          const top = r.top > estH + 16 ? r.top - estH - 8 : Math.min(r.bottom + 8, (window.innerHeight || 800) - estH - 16);
          setPos({ top: Math.max(12, top), left: left });
        }
        setOpen(!open);
      }, [open]);
      const lg = st.data && st.data.ledger;
      useCfgVersion(); // 紧凑模式等改动后立即生效
      const gcfg = getCfg && getCfg();
      const compact = !!(gcfg && gcfg.sidebarCompact === true);
      const chCount = st.data && st.data.channels ? (st.data.channels.credits || st.data.channels.providers || []).length : 0;
      const chOk = !!(st.data && st.data.channels && st.data.channels.credits);
      const officialNum = st.data && st.data.official && st.data.official.wallets && st.data.official.wallets.length
        ? st.data.official.wallets.reduce(function (s, w) { return s + (Number(w.total) || 0); }, 0)
        : (lg && lg.official ? Number(lg.official.total) : null);
      const cfgV = useCfgVersion();
      const __cfgNow = getCfg && getCfg();
      const cur = (__cfgNow && __cfgNow.currency) || "CNY";
            return h("div", { className: "uq-root" },
        h("div", { className: "uq-bar", ref: anchor, onClick: toggle, role: "button", tabIndex: 0, "data-tip": dict[L].title },
          h("span", { className: "uq-seg" }, Dot(officialNum !== null), officialNum === null ? h("span", { className: "uq-dim" }, dict[L].noData) : h("span", { className: "uq-num" }, money(officialNum, cur))),
          !compact ? h("span", { className: "uq-dim", style: { fontSize: 10, opacity: .75 } }, L === "zh" ? "额度中心" : "quota") : null,
          !compact ? h("span", { className: "uq-dim" }, "·") : null,
          !compact ? h("span", { className: "uq-seg" }, Dot(chOk), h("span", { className: "uq-num" }, String(chCount)), h("span", { className: "uq-dim" }, L === "zh" ? "渠道" : "channels")) : null,
          !compact && lg ? h(react.Fragment, null,
            h("span", { className: "uq-dim" }, "·"),
            h("span", { className: "uq-seg" }, h("span", { className: "uq-dim" }, L === "zh" ? "今日" : "today"), h("span", { className: "uq-num" }, money(lg.today.apiCost, lg.currency || "USD")))) : null,
          st.error ? h("span", { className: "uq-dot", "data-ok": "0", style: { marginLeft: "auto" } }) : null),
        open && st.data ? mountPop(h(Popover, { key: "uq-pop", core: st.data, extra: st.extra, L: L, busy: st.busy, onRefresh: st.load, onClose: function () { setOpen(false); }, pos: pos, onOpenDetail: function () { setOpen(false); setDetail(true); } })) : null,
        detail ? mountPop(h(UqErrorBoundary, { key: "uq-detail-eb" }, h(DetailSheet, { key: "uq-detail", L: L, onClose: function () { setDetail(false); } }))) : null);
    }
    function slotsOf(ctx) {
      try {
        if (ctx && ctx.slots && typeof ctx.slots.inject === "function") return ctx.slots;
        if (ctx && typeof ctx.get === "function") {
          const s = ctx.get("slots");
          if (s && typeof s.inject === "function") return s;
        }
      } catch (e) { /* fall through */ }
      return null;
    }
    /** Header entry: sits right next to cost-meter's own 费用明细 button. */
    /** 模块级「面板是否打开」状态：DSH slot 会重建组件（实测 3 次 entry-mount），
 *  组件内 useState 会被重置 ⇒ 必须放在组件外，用事件同步。 */
let __uqPanelOpen = false;
const __uqPanelSubs = new Set();
function __uqSetPanelOpen(v) {
  if (__uqPanelOpen === v) return;
  __uqPanelOpen = v;
  for (const fn of __uqPanelSubs) { try { fn(v); } catch (e) {} }
}
if (typeof window !== "undefined" && !window.__uqPanelHooked) {
  window.__uqPanelHooked = true;
  window.addEventListener("unified-quota:open", function () { __uqSetPanelOpen(true); });
  window.addEventListener("unified-quota:close", function () { __uqSetPanelOpen(false); });
}

function DetailEntryButton(props) {
      const L = locale();
      // 订阅模块级状态（不用 useState 的初值，避免重建时重置）
      const [open, setOpen] = react.useState(__uqPanelOpen);
      react.useEffect(function () {
        setOpen(__uqPanelOpen);
        const fn = function (v) { setOpen(v); };
        __uqPanelSubs.add(fn);
        return function () { __uqPanelSubs.delete(fn); };
      }, []);
      // ⚠️ 本组件被注册两次（slot 内 + fallback 独立 createRoot），
      // 两个实例各有独立 open state ⇒ 点 A 时 A.open=true 但 A 不渲染面板（B 才是可见入口）
      // ⇒ 表现为「点不开」。用 window 事件让所有实例同步 open，但关闭时全部同步关闭。
      const selfIdRef = react.useRef(null);
      if (selfIdRef.current === null) selfIdRef.current = "e" + Math.random().toString(36).slice(2, 8);
      react.useEffect(function () {
        try { beacon("entry-mount", "id=" + selfIdRef.current); } catch (x) {}
        return function () { try { beacon("entry-unmount", "id=" + selfIdRef.current); } catch (x) {} };
      }, []);
      react.useEffect(function () { try { beacon("entry-open", "id=" + selfIdRef.current + " open=" + open); } catch (x) {} }, [open]);
      react.useEffect(function () {
        // 监听由模块级 window 钩子处理，这里不再重复注册
        return function () {};
      }, []);
      return h(react.Fragment, null,
        h("button", {
          type: "button", className: "uq-entry", "data-tip": L === "zh" ? "多平台明细：按渠道 / 模型 / 日期 / 会话 · 实付与等值分列" : "Multi-channel details: channel / model / day / session",
          onClick: function (e) { try { e.stopPropagation(); } catch (x) {} try { beacon("entry-click", "standalone=" + !!(props && props.standalone) + " open=" + open); } catch (x) {} __uqSetPanelOpen(true); try { window.dispatchEvent(new CustomEvent("unified-quota:open", { detail: { from: selfIdRef.current } })); } catch (x) {} }
        }, L === "zh" ? "多平台明细" : "All channels"),
        open ? mountPop(h(UqErrorBoundary, { key: "uq-detail-entry-eb" }, h(DetailSheet, { key: "uq-detail-entry", L: L, onClose: function () { try { beacon("entry-sheet-close", "open=" + open); } catch (x) {} __uqSetPanelOpen(false); try { window.dispatchEvent(new CustomEvent("unified-quota:close")); } catch (x) {} } }))) : null);
    }
    function beacon(stage, detail) {
      try {
        const q = "/api/unified-quota/beacon?stage=" + encodeURIComponent(stage) + "&detail=" + encodeURIComponent(String(detail || "").slice(0, 280));
        void fetch(q, { credentials: "same-origin" }).catch(function () {});
      } catch (e) { /* diagnostics only */ }
    }
    /**
     * 零依赖兜底入口：不经过 slots（不同宿主版本对客户端插件 apply 的 ctx 契约有差异）。
     * 把一条固定定位的小按钮挂到 body，点开就是详细页；slots 成功时它会自己收起，
     * 避免重复入口。
     */
    let fallbackSheetHost = null;
    function openFallbackSheet(L) {
      try {
        ensureCss();
        if (fallbackSheetHost !== null && document.body.contains(fallbackSheetHost)) return;
        const host = document.createElement("div");
        host.setAttribute("data-unified-quota-sheet", "1");
        document.body.appendChild(host);
        fallbackSheetHost = host;
        const rd = require("react-dom");
        const api = require("react");
        const node = api.createElement(DetailSheet, { L: L, onClose: function () { try { host.remove(); } catch (e) { host.innerHTML = ""; } fallbackSheetHost = null; } });
        if (rd.createRoot) rd.createRoot(host).render(node);
        else if (typeof rd.render === "function") rd.render(node, host);
        beacon("fallback-sheet-open", "");
      } catch (e) { beacon("fallback-sheet-failed", e && e.message); }
    }
    let fallbackHost = null;
    function mountFallback(L) {
      try {
        if (fallbackHost !== null && document.body.contains(fallbackHost)) return;
        if (!document.body) return;
        const host = document.createElement("div");
        host.setAttribute("data-unified-quota-fallback", "1");
        host.style.cssText = "position:fixed;right:16px;bottom:64px;z-index:22500;";
        document.body.appendChild(host);
        fallbackHost = host;
        beacon("fallback-mounted", "");
        // 兜底入口：用 React 渲染真正的按钮组件（它自身带 .uq-sheet 弹层与事件）
        let rendered = false;
        try {
          const rd = require("react-dom");
          const api = require("react");
          const node = api.createElement(DetailEntryButton, { standalone: true });
          if (rd.createRoot) { const root = rd.createRoot(host); root.render(node); rendered = true; }
          else if (typeof rd.render === "function") { rd.render(node, host); rendered = true; }
        } catch (e) { rendered = false; }
        if (!rendered) {
          // 连 React 都拿不到：退化为纯 DOM 按钮 + 自己管理的弹层（同样打开 DetailSheet）
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "uq-entry";
          btn.textContent = L === "zh" ? "多平台明细" : "All channels";
          btn.onclick = function () { openFallbackSheet(L); };
          host.innerHTML = "";
          host.appendChild(btn);
        }
      } catch (e) { beacon("fallback-failed", e && e.message); }
    }
    /** 槽位成功渲染时会留下 .uq-root；超时仍没有就说明槽位没接住，落 DOM 兜底。 */
    function ensureVisible(L) {
      try {
        setTimeout(function () {
          try {
            const hasSlotUi = document.querySelector(".uq-root, .uq-bar, .uq-entry");
            if (!hasSlotUi) { beacon("slot-invisible", "mounting DOM fallback"); mountFallback(L); }
            else beacon("slot-visible", "ok");
          } catch (e) { beacon("selfcheck-failed", e && e.message); }
        }, 2500);
      } catch (e) { /* ignore */ }
    }

    /**
     * 挂载。三种宿主契约按序尝试（不同 DSH 版本对客户端插件 ctx 的服务可见性不同）：
     *   ① ctx.inject(['slots'], …) —— 等 slots 服务就绪再注册（jet-hub 用的就是这个）；
     *   ② ctx.get('slots') / ctx.slots —— 立即可见的老契约；
     *   ③ 都不成 → DOM 兜底入口（右下角按钮），保证永远有入口。
     * 关键：slots 在 apply() 的同步时刻往往还没 provide，早取只会拿到 undefined。
     */
    function registerInto(slots, ctx) {
      try {
        slots.inject("sidebar.footer.action", function () {
          return slots.register({ name: "sidebar.footer.action", id: "unified-quota", order: 9 }, UnifiedQuotaCard);
        });
        beacon("sidebar-registered", "");
      } catch (e) { beacon("sidebar-failed", e && e.message); }
      try {
        slots.inject("conversation.session.header.actions", function () {
          return slots.register({ name: "conversation.session.header.actions", id: "unified-quota-details", order: 2 }, DetailEntryButton);
        });
      } catch (e) { beacon("header-failed", e && e.message); }
      try {
        slots.inject("settings.section", function () {
          return slots.register({ name: "settings.section", id: "unified-quota", order: 60, label: function () { return locale() === "zh" ? "额度与费用" : "Quota & Cost"; } }, SettingsSection);
        });
      } catch (e) { beacon("settings-failed", e && e.message); }
      // 输入框**下方**的额度监控条（只显示当前会话最后使用的模型）
      try {
        slots.inject("conversation.composer.dock", function () {
          return slots.register({
            name: "conversation.composer.dock",
            id: "unified-quota-mini",
            order: 30,
            inject: function (sessionId) {
              // 诊断：确认插槽 inject 真的被调用、sessions 是否可用
              try {
                const hasSessions = !!(ctx.sessions && typeof ctx.sessions.binding === "function");
                const binding = hasSessions ? ctx.sessions.binding(sessionId) : undefined;
                const hasProjections = !!(binding && binding.session && binding.session.projections && typeof binding.session.projections.faceOf === "function");
                let face = null, snap = null;
                if (hasProjections) { try { face = binding.session.projections.faceOf("modelSelection"); snap = face && face.getSnapshot ? face.getSnapshot() : null; } catch (e2) { snap = "ERR:" + (e2 && e2.message); } }
                beacon("mini-inject", "sessions=" + hasSessions + " binding=" + !!binding + " proj=" + hasProjections + " snap=" + JSON.stringify(snap).slice(0, 200));
              } catch (e3) { beacon("mini-inject-err", String(e3 && e3.message).slice(0, 120)); }
              return {
                sessionId: sessionId,
                L: locale(),
                // 每次读取最新的「输入框选中模型」，切换后立即反映
                getPick: function () {
                  try {
                    const binding = ctx.sessions && typeof ctx.sessions.binding === "function" ? ctx.sessions.binding(sessionId) : undefined;
                    const face = binding && binding.session ? binding.session.projections.faceOf("modelSelection") : null;
                    const snap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : null;
                    if (!snap) return null;
                    // 真实结构：{ lastUsed, pending }（客户端可能把它别名为 next）
                    // pending 是「刚在下拉框里选中、还没发消息」的那个 —— 这正是要跟的
                    const pick = snap.pending || snap.next || snap.lastUsed || null;
                    if (!pick || !pick.provider || !pick.model) return null;
                    return { provider: pick.provider, model: pick.model };
                  } catch (e) { return null; }
                },
              };
            },
          }, QuotaMini);
        });
      } catch (e) { beacon("mini-failed", e && e.message); }
    }
    function apply(ctx) {
      ensureCss();
      // 初始化全局单例悬停气泡（portal 到 body，不受 overflow 裁切）
      try { ensureTipLayer(); } catch (e) {}
      // 启动时读一次配置到共享缓存：让所有设置项在首次渲染时就生效
      (async function () {
        try { const r = await fetch(CONFIG_URL, { credentials: "same-origin" }); if (r.ok) { const j = await r.json(); if (j && j.config) setSharedCfg(j.config); } } catch (e) { /* 忽略 */ }
      })();
      // 自研气泡已停用：它的定位在缩放下会漂移并引起抖动。
      // 需要主题化提示的地方改用 DSH 原生 Tooltip（tip()），其余保留浏览器 title（稳定）。
      const L = locale();
      beacon("apply", "keys=" + (ctx ? Object.keys(ctx).slice(0, 12).join(",") : "null"));
      let mounted = false;
      const claim = function (slots, via) {
        if (mounted || slots === null || slots === undefined) return;
        mounted = true;
        beacon("slots", "ok via " + via);
        registerInto(slots, ctx);
      };
      // ② 先试立即可见的
      claim(slotsOf(ctx), "direct");
      // ① 再挂等待式注入（slots 稍后被 provide 时会回调）
      try {
        if (ctx && typeof ctx.inject === "function") {
          ctx.inject(["slots"], function (scoped) {
            const slots = (scoped && scoped.slots) || slotsOf(scoped);
            if (slots && !mounted) claim(slots, "inject");
          });
        }
      } catch (e) { beacon("inject-failed", e && e.message); }
      // ③ 4 秒后仍未挂载 → DOM 兜底（并复查一次直接取，覆盖 inject 不可用的版本）
      try {
        setTimeout(function () {
          if (mounted) { ensureVisible(L); return; }
          claim(slotsOf(ctx), "late");
          if (mounted) { ensureVisible(L); return; }
          beacon("slots", "MISSING -> DOM fallback");
          mountFallback(L);
        }, 4000);
      } catch (e) { /* ignore */ }
    }
    exports.apply = apply;
    exports.inject = ["slots", "sessions"];
    exports.__test = { kilo: kilo, money: money, creditTier: creditTier, channelLabel: channelLabel, dayLabel: dayLabel, Popover: Popover, DetailSheet: DetailSheet, SettingsSection: SettingsSection, TrendChart: TrendChart, Composition: Composition, RankList: RankList, CallsView: CallsView, CreditBillView: CreditBillView, QuotaView: QuotaView, QuotaMini: QuotaMini, Help: Help, tip: tip, amountOf: amountOf, HBar: HBar, BAR_TINT: BAR_TINT, ProviderTable: ProviderTable, ModelTable: ModelTable, DayTable: DayTable, SessionTable: SessionTable, BucketTable: BucketTable, OfficialSection: OfficialSection, ChannelsSection: ChannelsSection, UsageSection: UsageSection, WhaleSection: WhaleSection };
    return module.exports;
  }
});