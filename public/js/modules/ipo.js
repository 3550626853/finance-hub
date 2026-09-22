/* modules/ipo.js — 新股消息视图 */
(function () {
  'use strict';
  const { $, $$, fmt, fmtInt, cnAmount, setHtml, esc, empty, errorBox, barChart, tag, toast } = UI;

  const state = { market: 'hs', data: null, keyword: '', stage: '' };

  /** 点击新股名称 → 进入该新股的资讯详情页（#iponews?stock=xxx） */
  function openNews(code, name) {
    if (!code) return;
    App.openIpoNews(code, name);
  }

  /** 统一的「可点击股票名」标签（带提示气泡） */
  const nameLink = (x, extraClass = '') => `<span class="stock-link ${extraClass}" data-ncode="${esc(x.codeFull || x.code)}"
      data-nname="${esc(x.name)}" title="查看「${esc(x.name)}」的资讯详情">${esc(x.name)}</span>`;

  async function render(market) {
    if (market && ['hs', 'hk', 'us'].includes(market)) state.market = market;
    $$('#ipoMarketSeg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.market === state.market));

    state.data = await UI.task(() => API.ipo(state.market), { loadingText: '正在收集新股发行信息…' });
    const d = state.data;

    setHtml('ipoKpis', `
      <div class="kpi">
        <div class="kpi-label">${esc(d.marketLabel)}新股总数</div>
        <div class="kpi-value">${fmtInt(d.stats.total)}<small>只</small></div>
        <div class="kpi-foot">数据日期 ${esc(d.dataDate)}</div>
      </div>
      <div class="kpi k-up">
        <div class="kpi-label">7 日内开启申购</div>
        <div class="kpi-value">${fmtInt(d.stats.upcoming7d)}<small>只</small></div>
        <div class="kpi-foot">可提前准备打新额度</div>
      </div>
      <div class="kpi k-warn">
        <div class="kpi-label">7 日内上市</div>
        <div class="kpi-value">${fmtInt(d.stats.listing7d)}<small>只</small></div>
        <div class="kpi-foot">关注上市首日表现</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">平均发行价</div>
        <div class="kpi-value">${d.stats.avgPrice === null ? '--' : fmt(d.stats.avgPrice)}</div>
        <div class="kpi-foot">区间 ${d.stats.minPrice === null ? '--' : fmt(d.stats.minPrice)} ~ ${d.stats.maxPrice === null ? '--' : fmt(d.stats.maxPrice)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">已定价新股</div>
        <div class="kpi-value">${fmtInt(d.stats.priced)}<small>只</small></div>
        <div class="kpi-foot">有明确发行价 / 价格区间</div>
      </div>`);

    renderStages(d);
    renderFilters(d);
    renderTable();
    renderTimeline(d);
    renderPriceChart(d);
  }

  function renderStages(d) {
    const order = ['今日申购', '即将上市', '即将发行', '中签结果', '已上市'];
    const groups = (d.groups || []).slice().sort((a, b) => {
      const ia = order.indexOf(a.label); const ib = order.indexOf(b.label);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    if (!groups.length) { setHtml('ipoStages', empty('暂无新股发行数据')); return; }
    setHtml('ipoStages', groups.map((g) => `
      <div class="stage-col">
        <div class="stage-col-head">
          <div class="stage-col-title"><span class="dot-lg tone-${esc(g.tone)}"></span>${esc(g.label)}</div>
          <span class="stage-count">${g.items.length}</span>
        </div>
        ${g.items.slice(0, 6).map((x) => `
          <div class="stage-item">
            <div class="si-name">${nameLink(x)}
              <span class="${x.priceMid ? '' : 'dim'}" style="font-variant-numeric:tabular-nums">${x.priceMid ? fmt(x.priceMid) : '未定价'}</span></div>
            <div class="si-meta">${esc(x.code)}${x.listingDate ? ` · 上市 ${esc(x.listingDate)}` : x.subscribeStart ? ` · 申购 ${esc(x.subscribeStart)}` : ''}</div>
          </div>`).join('')}
        ${g.items.length > 6 ? `<div class="si-meta" style="margin-top:6px">…另有 ${g.items.length - 6} 只</div>` : ''}
      </div>`).join(''));

    bindNameLinks('#ipoStages');
  }

  function renderFilters(d) {
    const sel = $('#ipoStageFilter');
    if (!sel) return;
    const stages = [...new Set((d.list || []).map((x) => x.stage))];
    sel.innerHTML = '<option value="">全部阶段</option>' + stages.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (!sel.dataset.bound) {
      sel.dataset.bound = '1';
      sel.addEventListener('change', () => { state.stage = sel.value; renderTable(); });
    }
    const inp = $('#ipoSearch');
    if (inp && !inp.dataset.bound) {
      inp.dataset.bound = '1';
      let t = null;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { state.keyword = inp.value.trim(); renderTable(); }, 180);
      });
    }
  }

  function filtered() {
    let list = (state.data && state.data.list) || [];
    if (state.stage) list = list.filter((x) => x.stage === state.stage);
    if (state.keyword) {
      const k = state.keyword.toLowerCase();
      list = list.filter((x) =>
        String(x.name).toLowerCase().includes(k) ||
        String(x.code).toLowerCase().includes(k) ||
        String(x.industry).toLowerCase().includes(k));
    }
    return list;
  }

  function renderTable() {
    const list = filtered();
    if (!list.length) { setHtml('ipoTable', empty('没有匹配的新股')); return; }

    const rows = list.map((x) => {
      const countdown = x.daysToSubscribe !== null && x.daysToSubscribe >= 0
        ? (x.daysToSubscribe === 0 ? '<span class="tag tag-up">今日申购</span>' : `<span class="tag tag-hot">${x.daysToSubscribe} 天后</span>`)
        : (x.daysToListing !== null && x.daysToListing >= 0
          ? (x.daysToListing === 0 ? '<span class="tag tag-up">今日上市</span>' : `<span class="tag tag-warn">${x.daysToListing} 天后上市</span>`)
          : '<span class="dim">--</span>');
      return `<tr>
        <td>${nameLink(x, 'strong')}<div class="dim mono" style="font-size:11px">${esc(x.code)}</div></td>
        <td>${tag(x.stage, x.tone)}</td>
        <td class="dim" style="font-size:12.5px">${x.industry && x.industry !== '未知' ? esc(x.industry) : '<span class="dim">--</span>'}</td>
        <td class="num mono">${x.priceText ? esc(x.priceText) : '<span class="dim">--</span>'}</td>
        <td class="num mono">${esc(x.subscribeStart || '--')}${x.subscribeEnd && x.subscribeEnd !== x.subscribeStart ? `<br><span class="dim" style="font-size:11px">至 ${esc(x.subscribeEnd)}</span>` : ''}</td>
        <td class="num mono">${esc(x.listingDate || '--')}</td>
        <td class="num">${countdown}</td>
      </tr>`;
    }).join('');

    setHtml('ipoTable', `<table class="dt">
      <thead><tr><th>名称 / 代码</th><th>阶段</th><th>行业</th><th class="num">发行价</th><th class="num">申购日期</th><th class="num">上市日期</th><th class="num">倒计时</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p style="font-size:12px;color:var(--muted);margin:10px 0 0">点击股票名称可进入该新股的资讯详情页。共 ${list.length} 只。</p>`);

    bindNameLinks('#ipoTable');
  }

  /** 绑定所有「可点击股票名」→ 资讯详情页 */
  function bindNameLinks(scope) {
    $$(`${scope} .stock-link`).forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      openNews(el.dataset.ncode, el.dataset.nname);
    }));
  }

  function renderTimeline(d) {
    const tl = d.timeline || [];
    if (!tl.length) { setHtml('ipoTimeline', empty('暂无已定上市日的新股')); return; }
    setHtml('ipoTimeline', tl.map((x) => `
      <div class="tl-item">
        <div class="tl-date">${esc(String(x.date).slice(5))}</div>
        <div class="tl-body">
          <div class="tl-title">${nameLink(x)} <span class="dim mono" style="font-size:11.5px">${esc(x.code)}</span></div>
          <div class="tl-meta">${esc(x.market)} · ${esc(x.stage)}${x.priceMid ? ` · 发行价 ${fmt(x.priceMid)}` : ''}</div>
        </div>
      </div>`).join(''));

    bindNameLinks('#ipoTimeline');
  }

  function renderPriceChart(d) {
    const h = d.stats.priceHist;
    if (!h || !h.labels.length) {
      const c = document.getElementById('ipoPriceChart');
      if (c) c.parentElement.innerHTML = empty('暂无可统计的发行价数据');
      return;
    }
    barChart('ipoPriceChart', h.labels, [{
      label: '新股数量', data: h.counts,
      backgroundColor: UI.C.primary + 'cc', borderRadius: 4, barPercentage: 0.7,
    }], { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } });
  }

  function initSeg() {
    $$('#ipoMarketSeg .seg-item').forEach((b) => b.addEventListener('click', () => {
      history.replaceState(null, '', `#ipo/${b.dataset.market}`);
      render(b.dataset.market);
    }));
  }

  window.ViewIpo = { render, initSeg };
})();
