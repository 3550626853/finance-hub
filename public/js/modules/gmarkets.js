/* modules/gmarkets.js — 全球行情视图（贵金属 + 外汇） */
(function () {
  'use strict';
  const { $, $$, fmt, fmtInt, pct, cls, setHtml, esc, empty, errorBox, toast, lineChart, sparkline } = UI;

  const state = { tab: 'metals', metals: null, fx: null, fxTrendFor: null, charts: {} };

  async function render(sub) {
    bindOnce();
    if (sub && ['metals', 'forex'].includes(sub)) state.tab = sub;
    $$('#gmSeg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    $('#gmMetals').hidden = state.tab !== 'metals';
    $('#gmForex').hidden = state.tab !== 'forex';

    if (state.tab === 'metals') return loadMetals();
    return loadFx();
  }

  function switchTab(tab) {
    state.tab = tab;
    App.go('gmarkets', { sub: tab, force: true });
  }

  // ============================================================
  // 贵金属
  // ============================================================
  async function loadMetals({ force = false } = {}) {
    if (state.metals && !force) { drawMetals(state.metals); return; }
    setHtml('gmMetalKpis', `<div class="kpi"><div class="loading-inline dim">正在获取贵金属实时行情…</div></div>`);
    try {
      const d = force ? await UI.task(() => API.metals(), { loadingText: '正在刷新贵金属行情…' }) : await API.metals();
      state.metals = d;
      drawMetals(d);
    } catch (e) {
      setHtml('gmMetalKpis', errorBox(e.message));
    }
  }

  async function drawMetals(d) {
    const [gold, silver] = d.list;
    setHtml('gmMetalKpis', d.list.map((m) => `
      <div class="kpi ${m.changePct >= 0 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">${esc(m.name)}</div>
        <div class="kpi-value">${fmt(m.price)}</div>
        <div class="kpi-foot"><span class="${cls(m.changePct)}">${pct(m.changePct)}</span> · ${esc(m.unit)}</div>
      </div>`).join('') + `
      <div class="kpi">
        <div class="kpi-label">更新时间</div>
        <div class="kpi-value" style="font-size:15px">${esc((gold.updateTime || '--').slice(11))}</div>
        <div class="kpi-foot">${d.list.some((m) => m.isDelayed) ? '行情可能延迟（数据源标记）' : '实时快照'}</div>
      </div>`);

    // 代理走势图
    for (const [m, chartId, subId] of [[gold, 'gmGoldChart', 'gmGoldSub'], [silver, 'gmSilverChart', 'gmSilverSub']]) {
      setHtml(subId, `以 ${esc(m.proxy.name)} 为代理 · 近 90 日`);
      try {
        const t = await API.metalTrend(m.key, 90);
        const s = t.stats.series || [];
        drawTrendChart(chartId, s.map((x) => x.date.slice(5)), s.map((x) => x.close), m.changePct >= 0 ? UI.C.up : UI.C.down, false);
      } catch (e) { /* 单图失败不阻断 */ }
    }

    setHtml('gmMetalTable', `<table class="dt">
      <thead><tr><th>品种</th><th class="num">现价</th><th class="num">涨跌幅</th><th class="num">今开</th>
        <th class="num">最高</th><th class="num">最低</th><th class="num">20日区间</th><th class="num">20日年化波动</th><th class="num">20日涨跌</th></tr></thead>
      <tbody>${d.list.map((m) => {
        const t = m.trend || {};
        return `<tr>
          <td><span class="strong">${esc(m.name)}</span><div class="dim mono" style="font-size:11px">${esc(m.code)} · ${esc(m.proxy.name)}</div></td>
          <td class="num strong">${fmt(m.price)}</td>
          <td class="num ${cls(m.changePct)}">${pct(m.changePct)}</td>
          <td class="num">${fmt(m.open)}</td>
          <td class="num">${fmt(m.high)}</td>
          <td class="num">${fmt(m.low)}</td>
          <td class="num">${t.hi20 != null ? `${fmt(t.hi20)} ~ ${fmt(t.lo20)}` : '--'}</td>
          <td class="num">${t.vol20 != null ? fmt(t.vol20) + '%' : '--'}</td>
          <td class="num ${cls(t.chg20d)}">${pct(t.chg20d)}</td>
        </tr>`;
      }).join('')}</tbody></table>
      <p style="font-size:12px;color:var(--muted);margin:10px 0 0">${esc(d.note)}</p>`);
  }

  // ============================================================
  // 外汇
  // ============================================================
  async function loadFx({ force = false } = {}) {
    if (state.fx && !force) { drawFx(state.fx); return; }
    setHtml('gmFxKpis', `<div class="kpi"><div class="loading-inline dim">正在获取汇率行情…</div></div>`);
    try {
      const d = force ? await UI.task(() => API.fx(), { loadingText: '正在刷新外汇行情…' }) : await API.fx();
      state.fx = d;
      drawFx(d);
    } catch (e) {
      setHtml('gmFxKpis', errorBox(e.message));
    }
  }

  function drawFx(d) {
    const usd = (d.groups.find((g) => g.key === '美元系') || {}).list || [];
    const cny = (d.groups.find((g) => g.key === '人民币系') || {}).list || [];
    const usdIdx = usd[0] || {};
    const usdcny = cny.find((x) => x.code === 'fxUSDCNY') || {};

    setHtml('gmFxKpis', `
      <div class="kpi ${usdIdx.changePct >= 0 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">美元指数</div>
        <div class="kpi-value">${fmt(usdIdx.price)}</div>
        <div class="kpi-foot"><span class="${cls(usdIdx.changePct)}">${pct(usdIdx.changePct)}</span> · 全球风险偏好之锚</div>
      </div>
      <div class="kpi ${usdcny.changePct >= 0 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">美元兑人民币</div>
        <div class="kpi-value">${fmt(usdcny.price)}</div>
        <div class="kpi-foot"><span class="${cls(usdcny.changePct)}">${pct(usdcny.changePct)}</span> · 20日 <span class="${cls(usdcny.trend && usdcny.trend.chg20d)}">${pct(usdcny.trend && usdcny.trend.chg20d)}</span></div>
      </div>
      <div class="kpi">
        <div class="kpi-label">覆盖货币对</div>
        <div class="kpi-value">${fmtInt(d.total)}<small>个</small></div>
        <div class="kpi-foot">${d.groups.map((g) => `${esc(g.key)} ${g.list.length}`).join(' · ')}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">更新时间</div>
        <div class="kpi-value" style="font-size:15px">${esc((usdcny.updateTime || '--').slice(11))}</div>
        <div class="kpi-foot">实时汇率快照</div>
      </div>`);

    setHtml('gmFxGroups', d.groups.map((g) => `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>${esc(g.key)}</h2><span class="card-sub">点击任意货币对查看走势与波动</span></div>
        <div class="table-wrap"><table class="dt">
          <thead><tr><th>货币对</th><th class="num">最新汇率</th><th class="num">涨跌幅</th><th class="num">今日区间</th>
            <th class="num">20日涨跌</th><th class="num">20日区间</th><th class="num">20日年化波动</th><th>说明</th></tr></thead>
          <tbody>${g.list.map((x) => {
            const t = x.trend || {};
            return `<tr class="row-click clickable" data-fx="${esc(x.code)}" title="点击查看走势图与波动详情">
              <td><span class="strong">${esc(x.name)}</span><div class="dim mono" style="font-size:11px">${esc(x.code)}</div></td>
              <td class="num strong">${fmt(x.price)}</td>
              <td class="num ${cls(x.changePct)}">${pct(x.changePct)}</td>
              <td class="num">${x.low != null ? `${fmt(x.low)} ~ ${fmt(x.high)}` : '--'}</td>
              <td class="num ${cls(t.chg20d)}">${pct(t.chg20d)}</td>
              <td class="num">${t.hi20 != null ? `${fmt(t.lo20)} ~ ${fmt(t.hi20)}` : '--'}</td>
              <td class="num ${t.vol20 != null && t.vol20 > 8 ? 'down' : ''}">${t.vol20 != null ? fmt(t.vol20) + '%' : '--'}</td>
              <td class="dim" style="font-size:12px">${esc(x.hint || '--')}</td>
            </tr>`;
          }).join('')}</tbody></table></div>
      </div>`).join('') + `<p style="font-size:12px;color:var(--muted);margin:2px 0 0">${esc(d.note)}</p>`);

    $$('#gmFxGroups tr.row-click').forEach((tr) => tr.addEventListener('click', () => {
      loadFxTrend(tr.dataset.fx, tr.querySelector('.strong').textContent);
    }));

    // 默认展开第一个主要货币对
    if (!state.fxTrendFor && d.groups.length && d.groups[0].list.length) {
      const first = d.groups[0].list[0];
      loadFxTrend(first.code, first.name);
    }
  }

  async function loadFxTrend(code, name) {
    state.fxTrendFor = code;
    const card = $('#gmFxTrendCard');
    card.hidden = false;
    setHtml('gmFxTrendTitle', `${esc(name || code)} · 走势详情`);
    setHtml('gmFxTrendSub', '日 K 与当日分时加载中…');
    $('#gmFxTrendCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      const t = await API.fxTrend(code, 90);
      const s = t.stats || {};
      setHtml('gmFxTrendSub', `${esc(t.hint || '')} · 近 ${s.days || '--'} 个交易日`);
      const labels = (t.daily || []).map((x) => x.date.slice(5));
      drawTrendChart('gmFxChart', labels, (t.daily || []).map((x) => x.close), (s.chg20d || 0) >= 0 ? UI.C.up : UI.C.down, true);
      setHtml('gmFxTrendStats', `
        <span class="stat-item">最新 <b>${fmt(s.series && s.series.length ? s.series[s.series.length - 1].close : null)}</b></span>
        <span class="stat-item">5 日 <b class="${cls(s.chg5d)}">${pct(s.chg5d)}</b></span>
        <span class="stat-item">20 日 <b class="${cls(s.chg20d)}">${pct(s.chg20d)}</b></span>
        <span class="stat-item">60 日 <b class="${cls(s.chg60d)}">${pct(s.chg60d)}</b></span>
        <span class="stat-item">20 日区间 <b>${s.hi20 != null ? `${fmt(s.lo20)} ~ ${fmt(s.hi20)}` : '--'}</b></span>
        <span class="stat-item">20 日年化波动 <b class="${s.vol20 != null && s.vol20 > 8 ? 'down' : ''}">${s.vol20 != null ? fmt(s.vol20) + '%' : '--'}</b></span>
        <span class="stat-item dim">当日分时 ${t.minute.length} 点</span>`);
    } catch (e) {
      setHtml('gmFxTrendSub', '');
      toast(`走势加载失败：${e.message}`, 'err');
    }
  }

  // ============================================================
  // 通用
  // ============================================================
  function drawTrendChart(id, labels, values, color, beginZero) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    state.charts[id] = UI.lineChart(id, labels, [{
      label: '收盘', data: values,
      borderColor: color, backgroundColor: color + '20',
      borderWidth: 2, tension: .25, pointRadius: 0, pointHoverRadius: 4, fill: true,
    }], {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: '#b6bfd0', font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: !!beginZero, ticks: { maxTicksLimit: 6, color: '#b6bfd0', font: { size: 10 } }, grid: { color: UI.C.grid } },
      },
    });
  }

  let bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    $$('#gmSeg .seg-item').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  }

  window.ViewGmarkets = { render };
})();
