/* app.js — 应用入口、路由与全局状态 */
(function () {
  'use strict';
  const { $, $$, toast } = UI;

  const VIEWS = {
    overview: { title: '总览', mod: () => window.ViewOverview },
    ipo: { title: '新股消息', mod: () => window.ViewIpo },
    iponews: { title: '新股资讯', mod: () => window.ViewIpoNews },
    stocks: { title: '股票列表', mod: () => window.ViewStocks },
    recommend: { title: '推荐榜单', mod: () => window.ViewRecommend },
    picker: { title: 'AI 选股', mod: () => window.ViewPicker },
    gmarkets: { title: '全球行情', mod: () => window.ViewGmarkets },
    worlddesk: { title: '国际形势', mod: () => window.ViewWorlddesk },
    finance: { title: '财报整理', mod: () => window.ViewFinance },
    market: { title: '市场分析', mod: () => window.ViewMarket },
    appendix: { title: '附录', mod: () => window.ViewAppendix },
  };

  const state = { view: null, sub: null, params: {}, rendered: new Set(), lastKey: null };

  /** 解析 #view/sub?k=v 形式的哈希 */
  function parseHash() {
    const raw = location.hash.slice(1);
    const qIdx = raw.indexOf('?');
    const pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx);
    const queryPart = qIdx === -1 ? '' : raw.slice(qIdx + 1);
    const [v, sub] = pathPart.split('/');
    const params = {};
    if (queryPart) {
      try { new URLSearchParams(queryPart).forEach((val, k) => { params[k] = val; }); } catch (_) { /* ignore */ }
    }
    return { view: VIEWS[v] ? v : null, sub: sub || null, params };
  }

  function buildHash(view, sub, params) {
    let h = view;
    if (sub) h += `/${sub}`;
    const qs = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return qs ? `${h}?${qs}` : h;
  }

  function setHash(view, sub, params) {
    const target = buildHash(view, sub, params);
    if (location.hash.slice(1) !== target) history.replaceState(null, '', `#${target}`);
  }

  async function go(view, { force = false, sub = null, params = {} } = {}) {
    if (!VIEWS[view]) view = 'overview';
    state.view = view;
    state.sub = sub;
    state.params = params || {};

    $$('#mainNav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    setHash(view, sub, params);

    const mod = VIEWS[view].mod();
    if (!mod || !mod.render) { UI.toast('视图加载失败', 'err'); return; }
    // 带参数的路由（如 ?code=xxx）不应被「已渲染」缓存跳过
    const hasParams = Object.keys(state.params).length > 0;
    const key = buildHash(view, sub, params);
    if (!force && !hasParams && state.rendered.has(key) && state.lastKey === key) return;
    state.lastKey = key;

    try {
      await mod.render(sub, state.params);
      state.rendered.add(key);
    } catch (e) {
      console.error(e);
      UI.toast(`${VIEWS[view].title}加载失败：${e.message}`, 'err', 4200);
    }
  }

  /** 跳转到某只股票的财报整理界面（供股票列表 / 推荐榜单 / 新股资讯调用） */
  function openStock(code, name) {
    if (!code) return;
    go('finance', { force: true, sub: 'single', params: { code, ...(name ? { name } : {}) } });
  }

  /** 跳转到某只股票的新股资讯详情页（供新股消息 / 总览调用） */
  function openIpoNews(code, name) {
    if (!code) return;
    go('iponews', { force: true, params: { stock: code, ...(name ? { name } : {}) } });
  }

  /**
   * 仅知股票名称时（如板块「领涨股」字段只有名称）先解析出证券代码再跳转。
   * 解析走搜索接口，带缓存，仅在用户点击时触发一次。
   */
  const resolveCache = new Map();
  async function openStockByName(name) {
    const key = String(name || '').trim();
    if (!key) return;
    if (resolveCache.has(key)) return openStock(resolveCache.get(key), key);
    try {
      const d = await API.financeSearch(key);
      const hit = (d.list || [])[0];
      if (!hit || !hit.code) { UI.toast(`未能解析「${key}」的证券代码`, 'err'); return; }
      resolveCache.set(key, hit.code);
      openStock(hit.code, hit.name || key);
    } catch (e) {
      UI.toast(`无法打开「${key}」：${e.message}`, 'err');
    }
  }

  function refresh() {
    const view = state.view || 'overview';
    state.rendered.clear();
    state.lastKey = null;
    UI.toast('正在刷新数据…', '', 1200);
    API.clearCache().catch(() => {});
    setTimeout(() => go(view, { force: true, sub: state.sub, params: state.params }), 200);
  }

  async function checkHealth() {
    const dot = $('#dsDot');
    const text = $('#dsText');
    try {
      const h = await API.health();
      const ok = h.westockAvailable;
      dot.className = `dot ${ok ? 'dot-ok' : 'dot-err'}`;
      text.textContent = ok ? '数据源正常' : '数据源不可用';
      text.title = `westock CLI: ${h.westockBin}\n已运行 ${h.uptimeSec}s\n订阅 ${h.store.enabledSubscriptions}/${h.store.subscriptions} · 未读 ${h.store.unread}`;
    } catch (e) {
      dot.className = 'dot dot-err';
      text.textContent = '服务未连接';
    }
  }

  // ---------- 启动 ----------
  function boot() {
    // 导航
    $$('#mainNav .nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
    $$('[data-goto]').forEach((el) => el.addEventListener('click', () => go(el.dataset.goto)));

    // 全局
    $('#btnRefresh').addEventListener('click', refresh);
    $('#ovReport').addEventListener('click', async () => {
      try {
        const r = await UI.task(() => API.exportReport(), { loadingText: '正在生成并导出市场报告…' });
        toast(`市场报告已导出（${r.sizeKB} KB）`, 'ok', 3000);
        window.open(r.url, '_blank');
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#ovOpenBell').addEventListener('click', () => Notify.open());

    // 通知中心
    Notify.init((data) => {
      if (state.view === 'overview' && state.rendered.has('overview') && data && data.list) {
        // 未读变化时同步总览的提醒卡片
        const wrap = document.getElementById('ovNotices');
        if (wrap && data.list.length) {
          wrap.innerHTML = data.list.slice(0, 6).map((n) => `
            <div class="lm-item">
              <span class="lm-rank ${n.level === 'high' ? 'top' : ''}">${n.level === 'high' ? '!' : '·'}</span>
              <div class="lm-main">
                <div class="lm-name" style="font-size:12.5px">${UI.esc(n.title)}</div>
                <div class="lm-sub">${UI.esc(n.category)} · ${UI.timeAgo(n.createdAt)}</div>
              </div>
            </div>`).join('');
        }
      }
    });

    // 模块 init（绑定事件）
    if (window.ViewIpo && ViewIpo.initSeg) ViewIpo.initSeg();
    if (window.ViewFinance && ViewFinance.init) ViewFinance.init();
    if (window.ViewMarket && ViewMarket.init) ViewMarket.init();
    if (window.ViewPicker && ViewPicker.init) ViewPicker.init();

    // 键盘快捷键：1-9 切换视图，r 刷新
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
      const map = { 1: 'overview', 2: 'ipo', 3: 'iponews', 4: 'stocks', 5: 'recommend', 6: 'picker', 7: 'gmarkets', 8: 'worlddesk', 9: 'finance', 0: 'market' };
      if (map[e.key]) go(map[e.key]);
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey) refresh();
    });

    window.addEventListener('hashchange', () => {
      const p = parseHash();
      if (p.view && (p.view !== state.view || p.sub !== state.sub || buildHash(p.view, p.sub, p.params) !== state.lastKey)) {
        go(p.view, { sub: p.sub, params: p.params });
      }
    });

    checkHealth();
    setInterval(checkHealth, 60000);

    const p = parseHash();
    go(p.view || 'overview', { force: true, sub: p.sub, params: p.params });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /**
   * 仅切换视图显隐、不重新渲染（供术语跳转「返回正文」使用，即时无网络等待）。
   * 原视图 DOM 仍在文档中（视图只是 hidden），因此可直接恢复。
   * @returns {boolean} 恢复成功返回 true；目标视图从未渲染过则返回 false（调用方回退到 go()）
   */
  function restore(view, sub, params) {
    const el = document.getElementById(`view-${view}`);
    if (!el) return false;
    const renderedBefore = state.rendered.has(buildHash(view, sub || null, params));
    if (!renderedBefore && !el.textContent.trim()) return false;

    state.view = view;
    state.sub = sub || null;
    state.params = params || {};
    state.lastKey = buildHash(view, state.sub, state.params);
    $$('#mainNav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    setHash(view, state.sub, state.params);
    return true;
  }

  window.App = { go, refresh, restore, openStock, openStockByName, openIpoNews, state };
})();
