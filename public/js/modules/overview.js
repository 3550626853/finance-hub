/* modules/overview.js — 总览视图 */
(function () {
  'use strict';
  const { $, $$, num, fmt, fmtInt, pct, cls, cnAmount, setHtml, esc, empty, errorBox, chart, barChart, bindRows, scoreColor } = UI;

  async function render() {
    const data = await UI.task(() => API.overview(), { loadingText: '正在汇总市场与新股数据…' });

    const b = data.breadth || {};
    const ov = b.overview || {};
    const p = data.profile || {};
    const ipo = data.ipo || {};

    // ---- 副标题 ----
    setHtml('ovSub', `数据日期 ${esc(p.dataDate || '--')} · 更新于 ${new Date(data.updatedAt).toLocaleString('zh-CN')} · 数据源：腾讯自选股数据接口`);
    setHtml('ovIdxTime', data.indices && data.indices[0] ? esc(data.indices[0].time) : '');

    // ---- KPI ----
    const regimeLabel = p.adjScore === null || p.adjScore === undefined ? '--'
      : p.adjScore >= 65 ? '偏强市' : p.adjScore >= 50 ? '中性偏强' : p.adjScore >= 35 ? '中性震荡' : '偏弱市';
    const regimeTone = p.adjScore >= 50 ? 'k-up' : p.adjScore >= 35 ? 'k-warn' : 'k-down';
    const upRatio = num(ov.upRatio);

    const kpis = [
      { label: '市场状态', value: regimeLabel, foot: `综合评分 ${p.adjScore === null || p.adjScore === undefined ? '--' : p.adjScore}（原始 ${p.rawScore ?? '--'}）`, cls: regimeTone },
      { label: '上涨家数占比', value: upRatio === null ? '--' : upRatio + '%', foot: `涨 ${fmtInt(ov.up)} / 跌 ${fmtInt(ov.down)} / 平 ${fmtInt(ov.flat)}`, cls: upRatio >= 50 ? 'k-up' : 'k-down' },
      { label: '两市成交额', value: cnAmount(b.amount), foot: b.amountPrev === null || b.amountPrev === undefined ? '较上日 --' : `较上日 ${b.amountPrev >= 0 ? '+' : ''}${cnAmount(b.amountPrev)}`, cls: b.amountPrev >= 0 ? 'k-up' : 'k-down' },
      { label: '涨停 / 跌停', value: `${fmtInt(ov.limitUp)} / ${fmtInt(ov.limitDown)}`, foot: `情绪：${esc((b.sentiment && b.sentiment.label) || '--')}`, cls: (ov.limitUp || 0) >= (ov.limitDown || 0) ? 'k-up' : 'k-down' },
      { label: '新股在发', value: fmtInt(ipo.total), foot: `7 日内待申购 ${ipo.stats && ipo.stats.upcoming7d != null ? ipo.stats.upcoming7d : 0} 只`, cls: 'k-warn' },
      { label: '未读提醒', value: fmtInt(data.notifications && data.notifications.unread), foot: `订阅规则 ${data.notifications ? data.notifications.enabledSubscriptions : 0} 条已启用`, cls: 'k-warn' },
    ];

    setHtml('ovKpis', kpis.map((k) => `
      <div class="kpi ${k.cls || ''}">
        <div class="kpi-label">${esc(k.label)}</div>
        <div class="kpi-value">${esc(k.value)}</div>
        <div class="kpi-foot">${k.foot}</div>
      </div>`).join(''));

    // ---- 指数 ----
    const idx = data.indices || [];
    setHtml('ovIndices', idx.length ? `<div class="table-wrap"><table class="dt">
      <thead><tr><th>指数</th><th class="num">点位</th><th class="num">涨跌幅</th><th class="num">成交额</th><th class="num">20日</th><th class="num">年初至今</th></tr></thead>
      <tbody>${idx.map((x) => `<tr>
        <td><span class="strong">${esc(x.name)}</span> <span class="dim" style="font-size:11px">${esc(x.role)}</span></td>
        <td class="num ${cls(x.changePct)}">${fmt(x.price)}</td>
        <td class="num ${cls(x.changePct)}">${pct(x.changePct)}</td>
        <td class="num">${cnAmount(x.amount)}</td>
        <td class="num ${cls(x.chg20d)}">${pct(x.chg20d)}</td>
        <td class="num ${cls(x.chgYtd)}">${pct(x.chgYtd)}</td>
      </tr>`).join('')}</tbody></table></div>` : empty('指数数据获取失败'));

    // ---- 涨跌分布图 ----
    const bins = b.bins || [];
    if (bins.length) {
      barChart('ovBreadthChart', bins.map((x) => x.bin), [{
        label: '家数',
        data: bins.map((x) => x.count),
        backgroundColor: bins.map((x) => (x.dir === '涨' ? UI.C.up : x.dir === '跌' ? UI.C.down : UI.C.flat)),
        borderRadius: 4, barPercentage: 0.72,
      }], { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } });
    } else {
      const c = document.getElementById('ovBreadthChart');
      if (c) c.parentElement.innerHTML = empty('涨跌分布数据暂不可用');
    }

    // ---- 市场画像 ----
    const dims = (p.strongest && p.weakest) ? [] : [];
    setHtml('ovProfDate', p.dataDate ? `数据日期 ${esc(p.dataDate)}` : '');
    renderProfileChart(data);

    // ---- 行业榜 ----
    try {
      const sec = await API.sectors({ kind: 'industry', type: 'changePct', order: 'desc', limit: 8 });
      setHtml('ovSectors', (sec.list || []).length ? `<div class="table-wrap"><table class="dt">
        <thead><tr><th>#</th><th>行业</th><th class="num">涨跌幅</th><th class="num">主力净流入</th><th>领涨股</th></tr></thead>
        <tbody>${sec.list.map((s) => `<tr>
          <td class="dim">${s.rank}</td>
          <td class="strong">${esc(s.name)}</td>
          <td class="num ${cls(s.changePct)}">${pct(s.changePct)}</td>
          <td class="num ${cls(s.mainNetInflow)}">${cnAmount(s.mainNetInflow)}</td>
          <td style="font-size:12px">${s.leader
            ? `<span class="stock-link" data-name="${esc(String(s.leader).replace(/[(（].*$/, '').trim())}"
                 title="查看该股详情">${esc(s.leader)}</span>`
            : '--'}</td>
        </tr>`).join('')}</tbody></table></div>` : empty('板块数据暂不可用'));

      $$('#ovSectors .stock-link').forEach((el) => el.addEventListener('click', () => {
        App.openStockByName(el.dataset.name);
      }));
    } catch (e) { setHtml('ovSectors', errorBox(e.message)); }

    // ---- 新股 ----
    const ipoList = ipo.list || [];
    setHtml('ovIpo', ipoList.length ? `<div class="table-wrap"><table class="dt">
      <thead><tr><th>名称</th><th>阶段</th><th class="num">发行价</th><th class="num">申购日</th><th class="num">上市日</th></tr></thead>
      <tbody>${ipoList.map((x) => `<tr class="row-click" data-code="${esc(x.codeFull || x.code)}" data-name="${esc(x.name)}" title="点击查看该股财报详情">
        <td><span class="strong">${esc(x.name)}</span><div class="dim mono" style="font-size:11px">${esc(x.code)}</div></td>
        <td>${UI.tag(x.stage, x.tone)}</td>
        <td class="num">${x.priceMid ? fmt(x.priceMid) : '<span class="dim">未定价</span>'}</td>
        <td class="num mono">${esc(x.subscribeStart || '--')}</td>
        <td class="num mono">${esc(x.listingDate || '--')}</td>
      </tr>`).join('')}</tbody></table></div>` : empty('暂无新股数据'));

    $$('#ovIpo tr.row-click').forEach((tr) => tr.addEventListener('click', () => {
      App.openStock(tr.dataset.code, tr.dataset.name);
    }));

    // ---- 最新提醒 ----
    try {
      const nt = await API.notifications({ limit: 6 });
      const list = nt.list || [];
      setHtml('ovNotices', list.length ? list.map((n) => `
        <div class="lm-item">
          <span class="lm-rank ${n.level === 'high' ? 'top' : ''}">${n.level === 'high' ? '!' : '·'}</span>
          <div class="lm-main">
            <div class="lm-name" style="font-size:12.5px">${esc(n.title)}</div>
            <div class="lm-sub">${esc(n.category)} · ${UI.timeAgo(n.createdAt)}</div>
          </div>
        </div>`).join('') : empty('暂无提醒，点击右上角铃铛可查看通知中心', '🔔'));
      Notify.updateBadge(nt.stats ? nt.stats.unread : 0);
    } catch (e) { setHtml('ovNotices', errorBox(e.message)); }
  }

  function renderProfileChart(data) {
    const p = data.profile || {};
    // 概览只展示有代表性的一批维度（13 维在总览中压缩为 8 维，完整版见市场分析）
    const list = [];
    const names = ['短期趋势方向', '短期趋势强度', '中长期趋势方向', '中长期趋势强度', '技术指标', '情绪指标', '成交量能', '估值水平'];
    // 需要完整维度 → 单独拉一次画像
    API.profile().then((full) => {
      const dims = (full.dims || []).filter((d) => names.includes(d.name));
      if (!dims.length) {
        const c = document.getElementById('ovProfileChart');
        if (c) c.parentElement.innerHTML = empty('画像数据暂不可用');
        return;
      }
      barChart('ovProfileChart', dims.map((d) => d.name), [{
        label: '得分（0-5）',
        data: dims.map((d) => d.score),
        // 评分类图表用中性蓝色顺序色阶，避免与涨跌红绿语义混淆
        backgroundColor: dims.map((d) => {
          const s = d.score === null ? 0 : d.score;
          return s >= 5 ? '#1d4ed8' : s >= 4 ? '#2563eb' : s >= 3 ? '#60a5fa' : s >= 2 ? '#93c5fd' : '#c7dbff';
        }),
        borderRadius: 4, barPercentage: 0.68,
      }], {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { afterLabel: (ctx) => `状态：${dims[ctx.dataIndex].status}` },
          },
        },
        scales: {
          x: { beginAtZero: true, max: 5, ticks: { stepSize: 1, color: '#8b95a8' }, grid: { color: UI.C.grid } },
          y: { ticks: { color: '#4a5568', font: { size: 11 } }, grid: { display: false } },
        },
      });
    }).catch(() => {
      const c = document.getElementById('ovProfileChart');
      if (c) c.parentElement.innerHTML = errorBox('画像数据获取失败');
    });
  }

  window.ViewOverview = { render };
})();
