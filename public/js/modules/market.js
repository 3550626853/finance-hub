/* modules/market.js — 市场分析视图 */
(function () {
  'use strict';
  const { $, $$, num, fmt, fmtInt, pct, cls, cnAmount, setHtml, esc, empty, errorBox, radarChart, barChart, lineChart, toast, tag } = UI;

  const state = {
    sectorView: 'changePct-desc',
    news: { data: null, sort: 'hot', cat: '' },
    report: null,
  };

  async function render(sub) {
    await UI.task(async () => {
      const [idx, breadth, profile] = await Promise.all([
        API.indices(), API.breadth(), API.profile(),
      ]);
      drawKpis(idx, breadth, profile);
      drawIndices(idx);
      drawRadar(profile);
      drawDist(breadth);
    }, { loadingText: '正在拉取市场多维数据…' });

    loadSectors();
    loadHot();
    loadNews();

    // 支持 #market/report 深链直达报告
    if (sub === 'report') generateReport();
  }

  // ---------- KPI ----------
  function drawKpis(idx, breadth, profile) {
    const ov = breadth.overview || {};
    const ud = breadth.updown || {};
    const dims = (profile.dims || []).filter((d) => d.score !== null);
    const strong = dims.slice().sort((a, b) => b.score - a.score)[0];
    const weak = dims.slice().sort((a, b) => a.score - b.score)[0];

    setHtml('mkKpis', `
      <div class="kpi ${profile.adjScore >= 50 ? 'k-up' : profile.adjScore >= 35 ? 'k-warn' : 'k-down'}">
        <div class="kpi-label">市场综合评分</div>
        <div class="kpi-value">${profile.adjScore ?? '--'}<small>/100</small></div>
        <div class="kpi-foot">原始评分 ${profile.rawScore ?? '--'} · 数据日期 ${esc(profile.dataDate || '--')}</div>
      </div>
      <div class="kpi ${(ov.upRatio || 0) >= 50 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">涨跌家数（涨/跌）</div>
        <div class="kpi-value">${fmtInt(ov.up)}<small class="down" style="font-size:15px"> / ${fmtInt(ov.down)}</small></div>
        <div class="kpi-foot">上涨占比 ${ov.upRatio ?? '--'}% · 平盘 ${fmtInt(ov.flat)}</div>
      </div>
      <div class="kpi k-up">
        <div class="kpi-label">涨停 / 跌停</div>
        <div class="kpi-value">${fmtInt(ov.limitUp)}<small class="down" style="font-size:15px"> / ${fmtInt(ov.limitDown)}</small></div>
        <div class="kpi-foot">停牌 ${fmtInt(ov.halt)} 家</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">两市成交额</div>
        <div class="kpi-value">${cnAmount(breadth.amount)}</div>
        <div class="kpi-foot">较上日 ${breadth.amountPrev == null ? '--' : (breadth.amountPrev >= 0 ? '+' : '') + cnAmount(breadth.amountPrev)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">20 日新高 / 新低</div>
        <div class="kpi-value">${fmtInt(ud.newHigh20)}<small class="down" style="font-size:15px"> / ${fmtInt(ud.newLow20)}</small></div>
        <div class="kpi-foot">60 日：${fmtInt(ud.newHigh60)} / ${fmtInt(ud.newLow60)}</div>
      </div>
      <div class="kpi k-warn">
        <div class="kpi-label">最强 / 最弱维度</div>
        <div class="kpi-value" style="font-size:15px">${esc(strong ? strong.name : '--')} / ${esc(weak ? weak.name : '--')}</div>
        <div class="kpi-foot">得分 ${strong ? strong.score : '--'} / ${weak ? weak.score : '--'}（满分 5）</div>
      </div>`);
  }

  // ---------- 指数 ----------
  function drawIndices(idx) {
    const list = idx.list || [];
    if (!list.length) { setHtml('mkIndices', empty('指数数据获取失败')); return; }
    setHtml('mkIdxTime', list[0].time ? `数据日期 ${esc(list[0].time)}` : '');
    setHtml('mkIndices', `<table class="dt">
      <thead><tr><th>指数</th><th class="num">最新点位</th><th class="num">涨跌</th><th class="num">涨跌幅</th>
        <th class="num">成交额</th><th class="num">5日</th><th class="num">10日</th><th class="num">20日</th><th class="num">60日</th>
        <th class="num">年初至今</th><th class="num">52周高</th><th class="num">52周低</th></tr></thead>
      <tbody>${list.map((x) => `<tr>
        <td><span class="strong">${esc(x.name)}</span> <span class="dim" style="font-size:11px">${esc(x.role)}</span></td>
        <td class="num strong ${cls(x.changePct)}">${fmt(x.price)}</td>
        <td class="num ${cls(x.change)}">${x.change == null ? '--' : (x.change > 0 ? '+' : '') + fmt(x.change)}</td>
        <td class="num ${cls(x.changePct)}">${pct(x.changePct)}</td>
        <td class="num">${cnAmount(x.amount)}</td>
        <td class="num ${cls(x.chg5d)}">${pct(x.chg5d)}</td>
        <td class="num ${cls(x.chg10d)}">${pct(x.chg10d)}</td>
        <td class="num ${cls(x.chg20d)}">${pct(x.chg20d)}</td>
        <td class="num ${cls(x.chg60d)}">${pct(x.chg60d)}</td>
        <td class="num ${cls(x.chgYtd)}">${pct(x.chgYtd)}</td>
        <td class="num dim">${fmt(x.high52)}</td>
        <td class="num dim">${fmt(x.low52)}</td>
      </tr>`).join('')}</tbody></table>`);
  }

  // ---------- 雷达 ----------
  function drawRadar(profile) {
    const dims = (profile.dims || []).filter((d) => d.score !== null);
    if (!dims.length) {
      const c = document.getElementById('mkRadarChart');
      if (c) c.parentElement.innerHTML = empty('画像数据暂不可用');
      return;
    }
    radarChart('mkRadarChart', dims.map((d) => d.name), [{
      label: `市场画像（均分 ${profile.scoreAvg ?? '--'}）`,
      data: dims.map((d) => d.score),
      borderColor: UI.C.primary, backgroundColor: UI.C.primary + '26',
      borderWidth: 2, pointBackgroundColor: UI.C.primary, pointRadius: 3.5, pointHoverRadius: 5,
    }], {
      max: 5, step: 1,
      plugins: {
        legend: { display: true },
        tooltip: { callbacks: { afterLabel: (ctx) => `状态：${dims[ctx.dataIndex].status}` } },
      },
    });
  }

  // ---------- 涨跌分布 ----------
  function drawDist(breadth) {
    const bins = breadth.bins || [];
    if (!bins.length) {
      const c = document.getElementById('mkDistChart');
      if (c) c.parentElement.innerHTML = empty('涨跌分布数据暂不可用');
      return;
    }
    barChart('mkDistChart', bins.map((x) => x.bin), [{
      label: '家数', data: bins.map((x) => x.count),
      backgroundColor: bins.map((x) => (x.dir === '涨' ? UI.C.up : x.dir === '跌' ? UI.C.down : UI.C.flat)),
      borderRadius: 4, barPercentage: .74,
    }], {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `  ${bins[ctx.dataIndex].count} 家（${bins[ctx.dataIndex].dir}）` } },
      },
      scales: { y: { beginAtZero: true } },
    });
  }

  // 领涨股字段形如「世联行(10.03)」，需剥离括号内的涨幅
  const leaderName = (s) => String(s || '').replace(/[(（].*$/, '').trim();

  // ---------- 板块 ----------
  async function loadSectors() {
    const [a, b] = state.sectorView.split('-');
    const kind = a === 'kind' ? b : 'industry';
    const type = a === 'kind' ? 'changePct' : a;
    const order = a === 'kind' ? 'desc' : b;
    setHtml('mkSectors', UI.skeleton(5));
    try {
      const d = await API.sectors({ kind, type, order, limit: 25 });
      const list = d.list || [];
      if (!list.length) { setHtml('mkSectors', empty('板块数据暂不可用')); return; }
      setHtml('mkSectors', `<table class="dt">
        <thead><tr><th>#</th><th>板块</th><th class="num">涨跌幅</th><th class="num">主力净流入</th>
          <th class="num">5日净流入</th><th class="num">成交额</th><th class="num">换手率</th><th class="num">上涨家数</th><th>领涨股</th></tr></thead>
        <tbody>${list.map((s) => `<tr>
          <td class="dim">${s.rank}</td>
          <td class="strong">${esc(s.name)} <span class="dim mono" style="font-size:10.5px">${esc(s.code || '')}</span></td>
          <td class="num ${cls(s.changePct)}">${pct(s.changePct)}</td>
          <td class="num ${cls(s.mainNetInflow)}">${cnAmount(s.mainNetInflow)}</td>
          <td class="num ${cls(s.mainNetInflow5d)}">${cnAmount(s.mainNetInflow5d)}</td>
          <td class="num">${cnAmount(s.turnover)}</td>
          <td class="num">${s.turnoverRate == null ? '--' : fmt(s.turnoverRate) + '%'}</td>
          <td class="num dim">${esc(s.upCount || '--')}</td>
          <td style="font-size:12px">${s.leader
            ? `<span class="stock-link" data-name="${esc(leaderName(s.leader))}" title="查看该股详情">${esc(s.leader)}</span>`
            : '--'}</td>
        </tr>`).join('')}</tbody></table>
        <p style="font-size:12px;color:var(--muted);margin:10px 0 0">主力净流入 / 成交额单位为万元换算后的元。共 ${d.total} 个板块，展示前 ${list.length} 名。点击「领涨股」可直接查看该股财报详情。</p>`);

      $$('#mkSectors .stock-link').forEach((el) => el.addEventListener('click', () => {
        App.openStockByName(el.dataset.name);
      }));
    } catch (e) { setHtml('mkSectors', errorBox(e.message)); }
  }

  // ---------- 热点 ----------
  async function loadHot() {
    setHtml('mkHotStocks', UI.skeleton(4));
    setHtml('mkHotSectors', UI.skeleton(4));
    try {
      const d = await API.hot();
      setHtml('mkHotStocks', (d.stocks || []).length ? d.stocks.slice(0, 10).map((x) => `
        <div class="lm-item clickable" data-code="${esc(x.code)}" data-name="${esc(x.name)}" title="点击查看该股财报详情">
          <span class="lm-rank ${x.rank <= 3 ? 'top' : ''}">${x.rank}</span>
          <div class="lm-main"><div class="lm-name">${esc(x.name)}</div><div class="lm-sub mono">${esc(x.code)}</div></div>
          <div style="text-align:right"><div class="${cls(x.changePct)}" style="font-weight:650;font-variant-numeric:tabular-nums">${pct(x.changePct)}</div>
            <div class="lm-sub">${fmt(x.price)}</div></div>
        </div>`).join('') : empty('暂无热搜数据'));

      $$('#mkHotStocks .lm-item').forEach((el) => el.addEventListener('click', () => {
        App.openStock(el.dataset.code, el.dataset.name);
      }));

      setHtml('mkHotSectors', (d.sectors || []).length ? d.sectors.slice(0, 10).map((x) => `
        <div class="lm-item">
          <span class="lm-rank ${x.rank <= 3 ? 'top' : ''}">${x.rank}</span>
          <div class="lm-main"><div class="lm-name">${esc(x.name)}</div>
            <div class="lm-sub">${x.rankDelta ? (x.rankDelta > 0 ? `↑ 上升 ${x.rankDelta} 位` : `↓ 下降 ${-x.rankDelta} 位`) : '排名持平'}</div></div>
          <div class="${cls(x.changePct)}" style="font-weight:650;font-variant-numeric:tabular-nums">${pct(x.changePct)}</div>
        </div>`).join('') : empty('暂无热门板块'));
    } catch (e) {
      setHtml('mkHotStocks', errorBox(e.message));
      setHtml('mkHotSectors', '');
    }
  }

  // ============================================================
  // 市场要闻
  // 结构：分类筛选 → 重点要闻（含摘要，卡片式）→ 更多要闻（按日期分组，紧凑列表）
  // ============================================================
  async function loadNews({ fresh = false } = {}) {
    setHtml('mkNewsBody', UI.skeleton(6));
    setHtml('mkNewsCats', '');
    setHtml('mkNewsMeta', fresh ? '正在回源刷新…' : '正在加载…');
    try {
      // 前 10 条补正文摘要：重点区需要段落级信息，其余条目保持简洁
      const d = fresh ? await API.refreshNews() : await API.marketNews({ limit: 40, detail: 10 });
      state.news.data = d;
      drawNewsMeta(d);
      drawNewsCats();
      drawNews();
    } catch (e) {
      setHtml('mkNewsMeta', '');
      setHtml('mkNewsBody', errorBox(e.message));
    }
  }

  function drawNewsMeta(d) {
    setHtml('mkNewsMeta',
      `共 ${d.total} 条 · 今日 ${d.todayCount} 条 · 最新 ${esc(d.latestTime || '--')} · 更新于 ${new Date(d.updatedAt).toLocaleTimeString('zh-CN')}`);
  }

  function drawNewsCats() {
    const d = state.news.data;
    if (!d) return;
    const cats = d.categories || [];
    const chip = (key, label, count, active) => `
      <button type="button" class="nc-chip ${active ? 'active' : ''}" data-cat="${esc(key)}">
        <span>${esc(label)}</span><span class="nc-count">${count}</span>
      </button>`;
    setHtml('mkNewsCats',
      chip('', '全部', d.total, !state.news.cat)
      + cats.map((c) => chip(c.key, c.label, c.count, state.news.cat === c.key)).join(''));

    $$('#mkNewsCats .nc-chip').forEach((el) => el.addEventListener('click', () => {
      state.news.cat = el.dataset.cat;
      drawNewsCats();
      drawNews();
    }));
  }

  function drawNews() {
    const d = state.news.data;
    if (!d) return;
    let list = (d.list || []).filter((x) => !state.news.cat || x.category.key === state.news.cat);
    // 「按热度」= 数据源热文榜排名；「按时间」= 发布时间倒序
    list = state.news.sort === 'time'
      ? list.slice().sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
      : list.slice().sort((a, b) => a.rank - b.rank);

    if (!list.length) { setHtml('mkNewsBody', empty('该分类下暂要闻', '📰')); return; }

    const key = list.slice(0, 3);
    const rest = list.slice(3);
    const groups = [];
    rest.forEach((x) => {
      const g = groups.find((y) => y.label === x.dayLabel);
      if (g) g.items.push(x); else groups.push({ label: x.dayLabel, items: [x] });
    });

    setHtml('mkNewsBody', `
      <div class="news-key">${key.map(keyCard).join('')}</div>
      ${groups.map((g) => `
        <div class="news-day">
          <div class="news-day-head">${esc(g.label)}<span class="news-day-count">${g.items.length} 条</span></div>
          ${g.items.map(rowHtml).join('')}
        </div>`).join('')}
      <p class="news-note">${esc(d.note)}<br>数据源：${esc(d.source)}${d.cached ? '（本次为缓存结果）' : ''}</p>`);
  }

  /** 重点要闻卡片：标题 + 摘要 + 来源/时间 */
  function keyCard(x) {
    return `<article class="nk-item">
      <div class="nk-top">
        <span class="nk-rank">${x.rank}</span>
        <span>${esc(x.time ? x.time.slice(11, 16) : '--')}</span>
        <span style="margin-left:auto">${esc(x.source)}</span>
      </div>
      <a class="nk-title" href="${esc(x.url || '#')}" target="_blank" rel="noopener">${esc(x.title)}</a>
      ${x.summary
        ? `<p class="nk-summary">${esc(x.summary)}</p>`
        : '<p class="nk-summary" style="color:var(--muted)">该条要闻暂未取到正文摘要，可点击标题查看原文。</p>'}
      <div class="nk-foot">${tag(x.category.label, x.category.tone)}${x.hasVideo ? tag('含视频', 'muted') : ''}</div>
    </article>`;
  }

  /** 更多要闻：紧凑单行 */
  function rowHtml(x) {
    return `<div class="nr-item">
      <span class="nr-time">${esc(x.time ? x.time.slice(11, 16) : '--')}</span>
      <a class="nr-title" href="${esc(x.url || '#')}" target="_blank" rel="noopener">${esc(x.title)}</a>
      <span class="nr-tag tag tag-${esc(x.category.tone)}">${esc(x.category.label)}</span>
      <span class="nr-src" title="${esc(x.source)}">${esc(x.source)}</span>
    </div>`;
  }

  // ---------- 报告 ----------
  async function generateReport() {
    const card = $('#mkReportCard');
    card.hidden = false;
    setHtml('mkReportBody', UI.skeleton(8));
    try {
      const r = await UI.task(() => API.report(), { loadingText: '正在生成市场分析报告…' });
      state.report = r;
      const ov = (r.breadth && r.breadth.overview) || {};
      const score = r.totalScore;
      setHtml('mkReportBody', `
        <div class="rp-kpis">
          <div class="rp-kpi"><div class="l">市场状态</div><div class="v">${esc(r.regime)}</div></div>
          <div class="rp-kpi"><div class="l">综合评分</div><div class="v ${score >= 50 ? 'up' : score >= 35 ? '' : 'down'}">${score ?? '--'}</div></div>
          <div class="rp-kpi"><div class="l">上涨家数占比</div><div class="v">${ov.upRatio ?? '--'}%</div></div>
          <div class="rp-kpi"><div class="l">两市成交额</div><div class="v">${cnAmount(r.breadth && r.breadth.amount)}</div></div>
          <div class="rp-kpi"><div class="l">数据日期</div><div class="v" style="font-size:16px">${esc(r.dataDate)}</div></div>
        </div>
        <div class="rp-section"><h3>一、市场概览</h3><p style="color:var(--ink-2);margin:0">${esc(r.indexText)}</p></div>
        <div class="rp-section"><h3>二、支撑因素</h3><ul class="rp-list">${(r.pros || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>暂无</li>'}</ul></div>
        <div class="rp-section"><h3>三、压制因素</h3><ul class="rp-list">${(r.cons || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>暂无</li>'}</ul></div>
        <div class="rp-section"><h3>四、策略建议</h3><ul class="rp-list">${(r.strategy || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="rp-section"><h3>五、行业涨幅 TOP5</h3>
          <div class="table-wrap"><table class="dt"><thead><tr><th>#</th><th>板块</th><th class="num">涨跌幅</th><th class="num">主力净流入</th></tr></thead>
          <tbody>${((r.sectors && r.sectors.top) || []).slice(0, 5).map((s, i) => `<tr><td class="dim">${i + 1}</td><td class="strong">${esc(s.name)}</td>
            <td class="num ${cls(s.changePct)}">${pct(s.changePct)}</td><td class="num ${cls(s.mainNetInflow)}">${cnAmount(s.mainNetInflow)}</td></tr>`).join('')}</tbody></table></div>
        </div>
        <div class="rp-section"><h3>六、主力资金净流入 TOP5</h3>
          <div class="table-wrap"><table class="dt"><thead><tr><th>#</th><th>板块</th><th class="num">涨跌幅</th><th class="num">主力净流入</th></tr></thead>
          <tbody>${((r.sectors && r.sectors.flow) || []).slice(0, 5).map((s, i) => `<tr><td class="dim">${i + 1}</td><td class="strong">${esc(s.name)}</td>
            <td class="num ${cls(s.changePct)}">${pct(s.changePct)}</td><td class="num ${cls(s.mainNetInflow)}">${cnAmount(s.mainNetInflow)}</td></tr>`).join('')}</tbody></table></div>
        </div>
        <p style="font-size:12px;color:var(--muted);margin-top:16px">${esc(r.disclaimer)}</p>`);
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('报告已生成，可导出为 HTML 文件', 'ok');
    } catch (e) {
      setHtml('mkReportBody', errorBox(e.message));
    }
  }

  function downloadJson() {
    if (!state.report) return;
    const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `market-report-${state.report.dataDate || 'today'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- 初始化 ----------
  function init() {
    $$('#mkSectorSeg .seg-item').forEach((b) => b.addEventListener('click', () => {
      state.sectorView = b.dataset.st;
      $$('#mkSectorSeg .seg-item').forEach((x) => x.classList.toggle('active', x === b));
      loadSectors();
    }));

    // 要闻排序：按热度（热文榜排名）/ 按时间（发布时间倒序）
    $$('#mkNewsSort .seg-item').forEach((b) => b.addEventListener('click', () => {
      state.news.sort = b.dataset.sort;
      $$('#mkNewsSort .seg-item').forEach((x) => x.classList.toggle('active', x === b));
      drawNews();
    }));

    $('#mkNewsRefresh').addEventListener('click', async () => {
      const btn = $('#mkNewsRefresh');
      if (btn.disabled) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '刷新中…';
      try { await loadNews({ fresh: true }); toast('要闻已刷新', 'ok', 1600); }
      catch (e) { toast(e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = old; }
    });

    $('#mkReport').addEventListener('click', generateReport);
    $('#mkExportHtml').addEventListener('click', async () => {
      try {
        const r = await UI.task(() => API.exportReport(), { loadingText: '正在导出 HTML 报告…' });
        toast(`报告已保存至 reports/ 目录（${r.sizeKB} KB）`, 'ok', 3200);
        window.open(r.url, '_blank');
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#mkDownloadJson').addEventListener('click', downloadJson);
  }

  window.ViewMarket = { render, init };
})();
