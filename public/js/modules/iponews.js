/* modules/iponews.js — 新股资讯视图 */
(function () {
  'use strict';
  const { $, $$, fmt, fmtInt, pct, cls, cnAmount, setHtml, esc, empty, errorBox, timeAgo, tag, toast } = UI;

  const state = {
    market: 'all',
    data: null,
    keyword: '',
    stock: null,        // { code, name } —— 正在查看的个股资讯
    stockData: null,
  };

  // ============================================================
  // 入口
  // ============================================================
  async function render(sub, params) {
    const mk = (params && params.market) || sub;
    if (mk && ['all', 'hs', 'hk'].includes(mk)) state.market = mk;
    // 深链：#iponews?stock=sh600519&name=xxx
    if (params && params.stock && (!state.stock || state.stock.code !== params.stock)) {
      state.stock = { code: params.stock, name: params.name || params.stock };
      state.stockData = null;
    } else if (params && params.stock === undefined && !sub) {
      // 从其它入口进入时不强制清空
    }

    bindOnce();
    $$('#ipnMarketSeg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.market === state.market));

    if (state.stock) {
      await renderStockView();
      // 直接深链进入个股视图时首屏不含全量数据，后台补载以供「切换到其他新股」使用
      if (!state.data) refreshStockChips();
      return;
    }

    setHtml('ipnStockView', '');
    $('#ipnDefault').hidden = false;

    state.data = await UI.task(
      () => API.ipoNews({ market: state.market, limit: 40, detail: 16 }),
      { loadingText: '正在聚合新股资讯并提取摘要…' }
    );
    const d = state.data;
    drawKpis(d);
    renderHot(d);
    renderStocks(d);
    renderFeed();
  }

  // ============================================================
  // 默认视图
  // ============================================================
  function drawKpis(d) {
    const latest = (d.list[0] || {}).time || '--';
    setHtml('ipnKpis', `
      <div class="kpi">
        <div class="kpi-label">资讯总数</div>
        <div class="kpi-value">${fmtInt(d.total)}<small>条</small></div>
        <div class="kpi-foot">覆盖 ${fmtInt(d.scannedStocks)} 只在发/待发新股</div>
      </div>
      <div class="kpi k-up">
        <div class="kpi-label">含摘要资讯</div>
        <div class="kpi-value">${fmtInt(d.withSummary)}<small>条</small></div>
        <div class="kpi-foot">摘要由资讯正文首段自动提取</div>
      </div>
      <div class="kpi k-warn">
        <div class="kpi-label">最新发布时间</div>
        <div class="kpi-value" style="font-size:17px">${esc(latest)}</div>
        <div class="kpi-foot">数据源：${esc(d.source)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">资讯最热新股</div>
        <div class="kpi-value" style="font-size:17px">${esc((d.hotStocks[0] || {}).name || '--')}</div>
        <div class="kpi-foot">${(d.hotStocks[0] || {}).newsCount ? `相关资讯 ${d.hotStocks[0].newsCount} 条` : '暂无'}</div>
      </div>`);

    const ps = d.perfStats || {};
    const seg = [];
    if (ps.surge) seg.push(`暴涨 ${ps.surge} 只`);
    if (ps.break) seg.push(`破发 ${ps.break} 只`);
    if (ps.pending) seg.push(`${ps.pending} 只未上市`);
    setHtml('ipnSubtitle', `共 ${d.total} 条${seg.length ? ` · ${seg.join(' / ')}` : ''} · 更新于 ${new Date(d.updatedAt).toLocaleTimeString('zh-CN')}`);
  }

  function renderHot(d) {
    const list = d.hotStocks || [];
    setHtml('ipnHotStocks', list.length ? list.map((x, i) => `
      <div class="lm-item clickable" data-code="${esc(x.codeFull || x.code)}" data-name="${esc(x.name)}"
           title="查看「${esc(x.name)}」的全部相关资讯">
        <span class="lm-rank ${i < 3 ? 'top' : ''}">${i + 1}</span>
        <div class="lm-main">
          <div class="lm-name">${esc(x.name)}</div>
          <div class="lm-sub mono">${esc(x.code)}</div>
        </div>
        <span class="tag tag-primary">${x.newsCount} 条</span>
      </div>`).join('') : empty('暂无数据'));

    $$('#ipnHotStocks .lm-item').forEach((el) => el.addEventListener('click', () => {
      showStockNews(el.dataset.code, el.dataset.name);
    }));
  }

  function renderStocks(d) {
    const list = d.stocks || [];
    setHtml('ipnStocks', list.length ? list.map((x) =>
      `<span class="chip clickable" data-code="${esc(x.codeFull || x.code)}" data-name="${esc(x.name)}"
             title="${esc(x.marketLabel)} · ${esc(x.stage)} · 点击查看该股全部资讯">
        ${esc(x.name)}<span class="dim" style="font-size:11px">${esc(x.code)}</span>
      </span>`).join('') : empty('暂无在发新股'));

    $$('#ipnStocks .chip').forEach((el) => el.addEventListener('click', () => {
      showStockNews(el.dataset.code, el.dataset.name);
    }));
  }

  function renderFeed() {
    const d = state.data;
    if (!d) return;
    let list = d.list || [];
    if (state.keyword) {
      const k = state.keyword;
      list = list.filter((x) =>
        String(x.title).toLowerCase().includes(k) ||
        String(x.source).toLowerCase().includes(k) ||
        String(x.name || '').toLowerCase().includes(k) ||
        String(x.code || '').toLowerCase().includes(k));
    }
    setHtml('ipnFeed', list.length ? list.map(newsItemHtml).join('') : empty(state.keyword ? '没有匹配的资讯' : '暂无新股资讯', '📰'));
    bindFeedChips('#ipnFeed');
  }

  /**
   * 上市表现（暴涨 / 破发）的展示片段。
   * 仅 status==='ready' 时才展开整句结论；数据缺失（pending / unknown）只显示低对比度标签，
   * 既不出现空白，也不会被误读成看空。
   */
  function perfTagHtml(p) {
    if (!p) return '';
    return `<span class="tag ${p.tagTone || 'tag-muted'} perf-tag" title="${esc(p.text || p.reason || '')}">${esc(p.tag || p.label || '待判定')}</span>`;
  }

  function perfLineHtml(p) {
    if (!p || p.status !== 'ready') return '';
    return `<p class="ni-perf ${p.cls || 'dim'}">${esc(p.text || '')}</p>`;
  }

  /** 单条资讯卡片（默认视图与个股视图共用） */
  function newsItemHtml(x) {
    return `
      <article class="news-item">
        <div class="ni-head">
          <span class="ni-time">${esc(x.time || '--')}</span>
          <span class="ni-source">${esc(x.source)}</span>
        </div>
        <a class="ni-title" href="${esc(x.url || '#')}" target="_blank" rel="noopener">${esc(x.title)}</a>
        ${x.summary
          ? `<p class="ni-summary">${esc(x.summary)}</p>`
          : `<p class="ni-summary ni-summary-empty">该条资讯暂未获取到正文摘要</p>`}
        ${perfLineHtml(x.perf)}
        <div class="ni-foot">
          ${x.name ? `<span class="chip chip-mini clickable" data-code="${esc(x.codeFull || x.code)}" data-name="${esc(x.name)}"
              title="查看该股全部资讯">${esc(x.name)} · ${esc(x.code)}</span>` : ''}
          ${perfTagHtml(x.perf)}
          ${x.stage ? tag(x.stage, x.tone || 'muted') : ''}
          ${x.marketLabel ? `<span class="dim" style="font-size:11.5px">${esc(x.marketLabel)}</span>` : ''}
          ${x.subscribeStart ? `<span class="dim" style="font-size:11.5px">申购 ${esc(x.subscribeStart)}</span>` : ''}
          ${x.listingDate ? `<span class="dim" style="font-size:11.5px">上市 ${esc(x.listingDate)}</span>` : ''}
        </div>
      </article>`;
  }

  function bindFeedChips(sel) {
    $$(`${sel} .chip`).forEach((el) => el.addEventListener('click', (e) => {
      e.preventDefault();
      showStockNews(el.dataset.code, el.dataset.name);
    }));
  }

  // ============================================================
  // 个股资讯视图（热度榜 / 关联新股 点击后进入）
  // ============================================================
  function showStockNews(code, name) {
    if (!code) return;
    state.stock = { code, name: name || code };
    state.stockData = null;
    history.replaceState(null, '', `#iponews?stock=${encodeURIComponent(code)}${name ? `&name=${encodeURIComponent(name)}` : ''}`);
    renderStockView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function backToAll() {
    state.stock = null;
    state.stockData = null;
    history.replaceState(null, '', `#iponews?market=${state.market}`);
    setHtml('ipnStockView', '');
    $('#ipnDefault').hidden = false;
    if (state.data) { drawKpis(state.data); renderHot(state.data); renderStocks(state.data); renderFeed(); }
    else render();
  }

  async function renderStockView() {
    const { code, name } = state.stock;
    $('#ipnDefault').hidden = true;
    setHtml('ipnStockView', `<div class="card">${UI.skeleton(8)}</div>`);

    if (!state.stockData) {
      try {
        state.stockData = await API.stockNews({ code, limit: 40, detail: 24 });
      } catch (e) {
        setHtml('ipnStockView', `<div class="card">
          <div class="card-head"><h2>${esc(name)} 相关资讯</h2></div>
          ${errorBox(e.message)}
          <div style="margin-top:12px"><button class="btn btn-sm" id="ipnBack">← 返回全部资讯</button></div>
        </div>`);
        const b = document.getElementById('ipnBack');
        if (b) b.addEventListener('click', backToAll);
        return;
      }
    }

    const d = state.stockData;
    const kw = state.keyword;
    let list = d.list || [];
    if (kw) {
      const k = kw.toLowerCase();
      list = list.filter((x) => String(x.title).toLowerCase().includes(k) || String(x.source).toLowerCase().includes(k));
    }

    setHtml('ipnStockView', `
      <div class="card stock-news-head">
        <div class="card-head" style="margin-bottom:12px">
          <h2>${esc(d.name)} 的全部相关资讯</h2>
          <div class="card-tools">
            <button class="btn btn-sm" id="ipnBack">← 返回全部资讯</button>
            <button class="btn btn-sm btn-primary" id="ipnGoFin">查看该股财报</button>
          </div>
        </div>
        <div class="stock-news-quote">
          <div class="snq-item"><span class="l">证券代码</span><span class="v mono">${esc(d.code)}</span></div>
          <div class="snq-item"><span class="l">最新价</span><span class="v ${cls(d.changePct)}">${fmt(d.price)}</span></div>
          <div class="snq-item"><span class="l">涨跌幅</span><span class="v ${cls(d.changePct)}">${pct(d.changePct)}</span></div>
          <div class="snq-item"><span class="l">总市值</span><span class="v">${cnAmount(d.marketCap === null ? null : d.marketCap * 1e8)}</span></div>
          <div class="snq-item"><span class="l">相关资讯</span><span class="v">${fmtInt(d.total)} 条</span></div>
          <div class="snq-item"><span class="l">含摘要</span><span class="v">${fmtInt(d.withSummary)} 条</span></div>
          ${d.perf && d.perf.status === 'ready' ? `<div class="snq-item"><span class="l">上市表现</span><span class="v ${d.perf.cls}">${esc(d.perf.label)}${d.perf.latestPct !== null && d.perf.latestPct !== undefined ? ` ${pct(d.perf.latestPct)}` : ''}</span></div>` : ''}
        </div>
        ${d.perf && d.perf.status === 'ready' ? `<p class="snq-note">上市表现：${esc(d.perf.text)}</p>` : ''}
        ${kw ? `<p class="snq-filter">当前在 ${list.length} 条结果中筛选关键词「${esc(kw)}」</p>` : ''}
      </div>
      <div class="card">
        <div class="card-head"><h2>资讯列表</h2>
          <span class="card-sub">按发布时间倒序 · 更新于 ${esc(new Date(d.updatedAt).toLocaleTimeString('zh-CN'))}</span></div>
        <div class="news-feed news-feed-inline">
          ${list.length ? list.map(newsItemHtml).join('') : empty('该股票暂无可抓取的资讯', '📰')}
        </div>
        <p class="snq-note">${esc(d.note || '')}</p>
      </div>
      <div class="card">
        <div class="card-head"><h2>切换到其他新股</h2><span class="card-sub">点击查看该股资讯</span></div>
        <div class="chip-row" id="ipnStockChips">${stockChips()}</div>
      </div>`);

    document.getElementById('ipnBack').addEventListener('click', backToAll);
    document.getElementById('ipnGoFin').addEventListener('click', () => App.openStock(d.code, d.name));
    bindFeedChips('#ipnStockView');
    bindStockChips();
  }

  /** 「切换到其他新股」的芯片列表 */
  function stockChips() {
    const list = (state.data && state.data.stocks) || [];
    return list.slice(0, 24).map((x) =>
      `<span class="chip clickable" data-code="${esc(x.codeFull || x.code)}" data-name="${esc(x.name)}">${esc(x.name)}</span>`).join('')
      || empty('暂无其他新股');
  }

  function bindStockChips() {
    $$('#ipnStockChips .chip').forEach((el) => el.addEventListener('click', () => {
      showStockNews(el.dataset.code, el.dataset.name);
    }));
  }

  /** 深链直达个股视图时，后台补载新股资讯数据以填充「切换到其他新股」 */
  function refreshStockChips() {
    API.ipoNews({ market: state.market, limit: 40, detail: 0 })
      .then((d) => {
        state.data = d;
        const host = document.getElementById('ipnStockChips');
        if (!host) return;
        setHtml('ipnStockChips', stockChips());
        bindStockChips();
      })
      .catch(() => { /* 非关键路径，失败静默 */ });
  }

  // ============================================================
  // 事件（只绑一次）
  // ============================================================
  function bindOnce() {
    const inp = $('#ipnSearch');
    if (inp && !inp.dataset.bound) {
      inp.dataset.bound = '1';
      let t = null;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          state.keyword = inp.value.trim();
          if (state.stock) renderStockView(); else renderFeed();
        }, 180);
      });
    }
    $$('#ipnMarketSeg .seg-item').forEach((b) => {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        state.market = b.dataset.market;
        state.stock = null;
        state.stockData = null;
        history.replaceState(null, '', `#iponews?market=${state.market}`);
        render(null, { market: state.market });
      });
    });
  }

  function init() { /* 事件在 render 内按需绑定 */ }

  window.ViewIpoNews = { render, init, showStockNews };
})();
