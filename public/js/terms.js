/* terms.js — 全站术语跳转：正文标注 → 附录定位高亮 → 可逆返回
 *
 * 设计要点：
 *   1. 术语清单来自后端统一索引 `GET /api/terms`（唯一数据源为 lib/appendix.js + lib/terms.js），
 *      前端不硬编码任何术语，新增术语无需改动本文件。
 *   2. 标注采用「最长别名优先」的文本节点替换，并用 MutationObserver 自动覆盖异步渲染的内容，
 *      因此各视图模块无需接入任何调用。
 *   3. 可访问性：使用原生 <button>（可 Tab 聚焦、Enter/Space 触发）、带 aria-label 与 title；
 *      尊重 prefers-reduced-motion（关闭平滑滚动）；移动端加大点击热区。
 *   4. 可逆：跳转前记录来源（视图 + 元素引用 + 回滚参数），附录显示「返回正文」条，
 *      点击后回到原视图并滚动、闪烁高亮原术语位置。
 */
(function () {
  'use strict';

  const state = {
    index: null,          // 术语索引
    matcher: null,        // 正则
    aliasMap: null,       // 别名 → {no, term}
    origin: null,         // 跳转来源
    timer: null,
    observer: null,
  };

  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = () => (REDUCED ? 'auto' : 'smooth');

  // ============================================================
  // 一、索引加载
  // ============================================================
  async function load() {
    if (state.index) return state.index;
    const idx = await API.terms();
    state.index = idx;
    const aliasMap = new Map();
    const parts = [];
    (idx.terms || []).forEach((t) => {
      (t.aliases || []).forEach((a) => { if (!aliasMap.has(a)) aliasMap.set(a, { no: t.no, term: t.term }); });
    });
    // 已按长度降序（后端保证），再统一转义用于正则
    [...aliasMap.keys()].sort((a, b) => b.length - a.length)
      .forEach((a) => parts.push(escapeRegExp(a)));
    state.aliasMap = aliasMap;
    state.matcher = parts.length ? new RegExp(`(?:${parts.join('|')})`, 'g') : null;
    return idx;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ============================================================
  // 二、正文标注
  // ============================================================
  const SKIP_TAGS = 'SCRIPT,STYLE,TEXTAREA,INPUT,SELECT,A,BUTTON,CODE,PRE';

  function annotatable(node) {
    const parent = node.parentElement;
    if (!parent) return false;
    if (parent.closest(SKIP_TAGS)) return false;
    if (parent.closest('.term-link')) return false;
    // 附录正文（词条本身）不参与标注，避免自指与噪音
    if (parent.closest('#apxMain, #apxToc, #apxSearch, [data-no-terms]')) return false;
    if (!parent.closest('.view')) return false;
    return true;
  }

  /**
   * 在 root 范围内把命中的术语包装为可点击按钮。
   * 注意：不做「已标注」缓存——视图常通过 setHtml 替换某块的内部 HTML，
   * 若按块缓存会漏掉后续异步渲染的内容。已标注的部分由 `.term-link` 子树跳过，
   * 重复扫描的成本可接受（debounce 合并 + 仅扫描当前活动视图）。
   */
  function annotate(root) {
    if (!state.matcher || !root) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
        return annotatable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);

    let count = 0;
    targets.forEach((node) => {
      const text = node.nodeValue;
      state.matcher.lastIndex = 0;
      if (!state.matcher.test(text)) return;
      state.matcher.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = state.matcher.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        frag.appendChild(makeLink(m[0]));
        last = m.index + m[0].length;
        count++;
        if (m.index === state.matcher.lastIndex) state.matcher.lastIndex++;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
    return count;
  }

  function makeLink(word) {
    const info = state.aliasMap.get(word) || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'term-link';
    btn.textContent = word;
    btn.dataset.no = info.no || '';
    btn.dataset.term = info.term || word;
    btn.title = `术语：${info.term || word}（附录 ${info.no || ''}）· 点击查看释义`;
    btn.setAttribute('aria-label', `查看术语「${info.term || word}」的释义，跳转到附录 ${info.no || ''}`);
    return btn;
  }

  // ============================================================
  // 三、跳转与返回
  // ============================================================
  function rememberOrigin(btn) {
    const viewEl = btn.closest('.view');
    state.origin = {
      view: viewEl ? viewEl.id.replace(/^view-/, '') : (window.App && App.state ? App.state.view : null),
      sub: window.App && App.state ? App.state.sub : null,
      params: window.App && App.state ? { ...App.state.params } : {},
      el: btn,
      hash: location.hash,
    };
  }

  async function goToTerm(btn) {
    const no = btn.dataset.no;
    if (!no) return;
    rememberOrigin(btn);
    await App.go('appendix', { force: true, params: { no } });
    // 附录渲染后会 jumpTo 目标条目；此处再补一次强度更高的闪烁确认
    setTimeout(() => {
      const el = document.getElementById(`apx-${no.replace(/\./g, '-')}`);
      if (el) {
        el.classList.remove('apx-flash');
        void el.offsetWidth;
        el.classList.add('apx-flash');
        setTimeout(() => el.classList.remove('apx-flash'), 1800);
      }
      renderBackBar();
    }, 420);
  }

  /** 附录顶部「返回正文」条（可逆跳转） */
  function renderBackBar() {
    const host = document.getElementById('view-appendix');
    if (!host || !state.origin) return;
    let bar = document.getElementById('apxBackBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'apxBackBar';
      bar.className = 'apx-back-bar';
      host.insertBefore(bar, host.firstChild);
    }
    const label = state.origin && state.origin.el ? state.origin.el.dataset.term : '正文';
    bar.innerHTML = `<button type="button" class="btn btn-sm btn-primary" id="apxBackBtn"
      aria-label="返回正文中术语「${UI.esc(label || '正文')}」所在位置">← 返回正文：${UI.esc(label || '正文')}</button>
      <span class="dim" style="font-size:12px">已定位到附录词条，可返回原位置继续阅读</span>`;
    const btn = document.getElementById('apxBackBtn');
    if (btn) {
      btn.addEventListener('click', backToOrigin);
      // 键盘用户：跳转后焦点落在返回按钮，便于直接回退
      setTimeout(() => { try { btn.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }, 300);
    }
  }

  function clearBackBar() {
    const bar = document.getElementById('apxBackBar');
    if (bar) bar.remove();
  }

  /** 返回正文：优先用「切换视图不重新渲染」的 restore（即时），缺失时回退到完整 go() */
  function backToOrigin() {
    const o = state.origin;
    if (!o) { clearBackBar(); return; }
    const done = () => {
      setTimeout(() => {
        const el = o.el;
        if (el && el.isConnected) {
          el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
          el.classList.remove('term-flash');
          void el.offsetWidth;
          el.classList.add('term-flash');
          setTimeout(() => el.classList.remove('term-flash'), 1800);
          try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
        } else {
          window.scrollTo({ top: o.scrollY || 0, behavior: scrollBehavior() });
        }
      }, 120);
      state.origin = null;
      clearBackBar();
    };

    let restored = false;
    if (window.App && typeof App.restore === 'function') {
      restored = App.restore(o.view, o.sub, o.params);
    }
    if (restored) done();
    else {
      App.go(o.view || 'overview', { sub: o.sub, params: o.params }).then(done).catch(done);
    }
  }

  // ============================================================
  // 四、初始化：事件委托 + 自动标注
  // ============================================================
  function scheduleAnnotate() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      const view = document.querySelector('.view.active');
      if (view) annotate(view);
    }, 450);
  }

  /** 对新增节点就地标注（异步渲染 / 页签切换），精度高成本低 */
  function annotateMutations(records) {
    records.forEach((r) => {
      (r.addedNodes || []).forEach((n) => {
        if (n.nodeType === 1) annotate(n);
        else if (n.nodeType === 3 && n.parentElement) annotate(n.parentElement);
      });
    });
  }

  async function init() {
    try { await load(); } catch (e) { console.warn('[terms] 索引加载失败，术语跳转已停用：', e.message); return; }

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.term-link');
      if (!btn) return;
      // 术语链接是「叶级操作」：必须阻止冒泡，
      // 否则位于可点击行内（如股票列表 tr.row-click）时会同时触发行跳转
      e.preventDefault();
      e.stopPropagation();
      goToTerm(btn);
    }, true);   // 捕获阶段：先于行点击处理器执行，确保冒泡被拦下

    scheduleAnnotate();
    // 异步渲染（页签切换、数据加载完成）后自动补标注：
    // 新增节点就地标注（精准），同时排一次全量扫描兜底
    if (window.MutationObserver) {
      state.observer = new MutationObserver((records) => {
        if (!document.querySelector('.view.active#view-appendix')) clearBackBar();
        try { annotateMutations(records); } catch (e) { /* 标注失败不影响主流程 */ }
        scheduleAnnotate();
      });
      state.observer.observe(document.getElementById('main') || document.body, { childList: true, subtree: true });
    }
  }

  window.Terms = {
    init,
    annotate: (root) => annotate(root),
    state,
    // 供测试与调试
    _goToTerm: goToTerm,
    _backToOrigin: backToOrigin,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
