/* modules/finance.js — 财报整理视图 */
(function () {
  'use strict';
  const { $, $$, fmt, fmtInt, pct, cls, cnAmount, setHtml, esc, empty, errorBox, lineChart, radarChart, toast, num } = UI;

  const state = {
    mode: 'single',
    picked: [],          // 单公司模式：仅取第一个
    compare: [],         // 对比模式
    single: null,
    compareData: null,
    compareMetric: 'profitability',
    tab: 'core',
    periodIdx: 0,
  };

  const WATCH_DEFAULT = [];

  // ============================================================
  // 渲染入口
  // ============================================================
  async function render(sub, params) {
    // 支持从「股票列表 / 推荐榜单 / 新股资讯」跳转过来并指定标的：#finance/single?code=sh600519
    const forcedCode = params && params.code ? String(params.code) : null;
    if (forcedCode) {
      state.mode = 'single';
      state.picked = [forcedCode];
      state.single = null;          // 清缓存，强制重新拉取该标的
      state.tab = 'core';
      state.periodIdx = 0;
    } else if (sub && ['single', 'compare', 'calendar'].includes(sub)) {
      state.mode = sub;
      if (sub === 'compare' && !state.compare.length) {
        // 进入对比模式时用自选股做默认对比样本
        try {
          const w = await API.watchlist();
          state.compare = (w.list || []).slice(0, 3);
        } catch (_) { /* ignore */ }
      }
    }
    $$('#finModeSeg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    $('#finSingle').hidden = state.mode !== 'single';
    $('#finCompare').hidden = state.mode !== 'compare';
    $('#finCalendar').hidden = state.mode !== 'calendar';

    renderChips();
    if (state.mode === 'calendar') return renderCalendar();
    if (state.mode === 'compare') return renderCompare();
    return renderSingle(!!forcedCode);
  }

  // ============================================================
  // 搜索
  // ============================================================
  function initSearch() {
    const inp = $('#finSearch');
    const sug = $('#finSuggest');
    let timer = null;
    let items = [];

    async function doSearch() {
      const q = inp.value.trim();
      if (!q) { sug.hidden = true; return; }
      try {
        const d = await API.financeSearch(q);
        items = d.list || [];
        if (!items.length) { sug.innerHTML = `<div class="suggest-item"><span class="n">未找到匹配标的</span></div>`; sug.hidden = false; return; }
        sug.innerHTML = items.slice(0, 10).map((x, i) =>
          `<div class="suggest-item" data-i="${i}"><span class="n">${esc(x.name)}</span><span class="c">${esc(x.code)}</span></div>`).join('');
        sug.hidden = false;
        $$('.suggest-item', sug).forEach((el) => el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(items[Number(el.dataset.i)]);
        }));
      } catch (e) { sug.hidden = true; }
    }

    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 260); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (items.length) pick(items[0]); else doSearch(); }
      if (e.key === 'Escape') sug.hidden = true;
    });
    $('#finSearchBtn').addEventListener('click', () => { if (items.length) pick(items[0]); else doSearch(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.search-input-wrap')) sug.hidden = true; });

    $('#finPickWatch').addEventListener('click', async () => {
      const w = await API.watchlist();
      if (!w.list || !w.list.length) { toast('自选股为空，可在「AI 选股 → 自选与持仓」中添加', 'err'); return; }
      if (state.mode === 'compare') {
        state.compare = w.list.slice(0, 4);
        renderChips();
        await renderCompare(true);
      } else {
        state.picked = [w.list[0]];
        renderChips();
        await renderSingle(true);
      }
      toast(`已载入 ${state.mode === 'compare' ? state.compare.length : 1} 个自选标的`, 'ok');
    });
  }

  function pick(item) {
    const code = item.code;
    if (state.mode === 'compare') {
      if (!state.compare.includes(code)) {
        if (state.compare.length >= 4) { toast('最多同时对比 4 家公司', 'err'); return; }
        state.compare.push(code);
      }
      renderChips();
      renderCompare(true);
    } else {
      state.picked = [code];
      renderChips();
      renderSingle(true);
    }
    $('#finSuggest').hidden = true;
    $('#finSearch').value = '';
  }

  function renderChips() {
    const list = state.mode === 'compare' ? state.compare : state.picked;
    setHtml('finChips', list.length ? list.map((c) =>
      `<span class="chip">${esc(c)}<span class="chip-x" data-code="${esc(c)}">✕</span></span>`).join('') : '');
    $$('#finChips .chip-x').forEach((x) => x.addEventListener('click', () => {
      const c = x.dataset.code;
      if (state.mode === 'compare') state.compare = state.compare.filter((y) => y !== c);
      else state.picked = [];
      renderChips();
      if (state.mode === 'compare') renderCompare(); else renderSingle();
    }));
  }

  // ============================================================
  // 单公司
  // ============================================================
  async function renderSingle(force) {
    if (!state.picked.length) {
      // 首次进入时用自选股第一只作为默认标的，避免空白页
      try {
        const w = state.watchPromise ? await state.watchPromise : await API.watchlist();
        if (w.list && w.list.length) { state.picked = [w.list[0]]; renderChips(); }
      } catch (_) { /* ignore */ }
    }
    if (!state.picked.length) {
      setHtml('finSingle', `<div class="card">${empty('输入股票名称或代码开始分析，或点击「载入自选股」', '🔎')}</div>`);
      return;
    }
    const code = state.picked[0];
    if (!force && state.single && state.single.code === code) { drawSingle(); return; }

    setHtml('finSingle', `<div class="card">${UI.skeleton(6)}</div>`);
    try {
      state.single = await API.finance(code, 12);
      state.tab = 'core';
      state.periodIdx = 0;
      drawSingle();
    } catch (e) {
      setHtml('finSingle', `<div class="card">${errorBox(e.message)}</div>`);
    }
  }

  function drawSingle() {
    const d = state.single;
    if (!d) return;
    const periods = d.periods || [];
    const latest = periods[0];
    const q = d.quote || {};

    const hero = `
      <div class="fin-hero">
        <div class="fin-hero-main">
          <div class="fin-hero-name">
            ${esc(d.name)}
            <span class="grade grade-${esc(d.grade)}" title="财报质量综合评级">${esc(d.grade)}</span>
            <span class="dim mono" style="font-size:13px;font-weight:400">${esc(d.code)}</span>
          </div>
          <div class="fin-hero-meta">
            最新报告期 ${esc(d.latestPeriod || '--')}${latest ? `（${esc(latest.reportLabel)}）` : ''}
            · 共归集 ${d.reportCount} 期 · 口径为年内累计 · 质量评分 <b>${d.score}</b> / 10
          </div>
        </div>
        <div class="fin-hero-quote">
          <div class="fin-q"><div class="l">最新价</div><div class="v ${cls(q.changePct)}">${fmt(q.price)}</div></div>
          <div class="fin-q"><div class="l">涨跌幅</div><div class="v ${cls(q.changePct)}">${pct(q.changePct)}</div></div>
          <div class="fin-q"><div class="l">市盈率</div><div class="v">${fmt(q.pe)}</div></div>
          <div class="fin-q"><div class="l">市净率</div><div class="v">${fmt(q.pb)}</div></div>
          <div class="fin-q"><div class="l">总市值</div><div class="v">${cnAmount(q.marketCap ? q.marketCap * 1e8 : null)}</div></div>
        </div>
      </div>`;

    const notes = (d.notes || []).length
      ? `<div class="fin-periods" style="flex-direction:column;gap:6px">${d.notes.map((n) => `<div style="font-size:12.5px;color:var(--ink-2)">• ${esc(n)}</div>`).join('')}</div>`
      : '';

    const tabs = `
      <div class="tabs" id="finTabs">
        <button class="tab active" data-tab="core">核心指标</button>
        <button class="tab" data-tab="income">利润表</button>
        <button class="tab" data-tab="balance">资产负债表</button>
        <button class="tab" data-tab="cash">现金流量表</button>
        <button class="tab" data-tab="trend">多期趋势</button>
      </div>`;

    setHtml('finSingle', `<div class="card">${hero}${notes}</div>
      <div class="card" id="finBizCard">
        <div class="card-head">
          <h2>主营业务与收入结构</h2>
          <span class="card-sub" id="finBizSub"></span>
        </div>
        <div id="finBizBody" class="dim" style="font-size:12.5px">正在加载公司主营信息…</div>
      </div>
      <div class="card">${tabs}<div id="finTabBody"></div></div>`);

    $$('#finTabs .tab').forEach((t) => t.addEventListener('click', () => {
      state.tab = t.dataset.tab;
      $$('#finTabs .tab').forEach((x) => x.classList.toggle('active', x === t));
      drawTab();
    }));
    drawTab();
    loadBusiness(d.code);
  }

  /** 主营业务卡片：公司档案 + 主营业务描述 + 收入-成本费用结构（异步加载，不阻塞主渲染） */
  async function loadBusiness(code) {
    try {
      const b = await API.financeBusiness(code);
      const p = b.profile || {};
      const st = b.structure;

      const archive = [
        p.industry ? ['所属行业', esc(p.industry)] : null,
        p.chairman ? ['董事长', esc(p.chairman)] : null,
        p.establishDate ? ['成立日期', esc(p.establishDate)] : null,
        p.listedDate ? ['上市日期', esc(p.listedDate)] : null,
        p.regCapitalWan ? ['注册资本', cnAmount(p.regCapitalWan * 1e4)] : null,
        p.officeAddress || p.regAddress ? ['公司地址', esc(p.officeAddress || p.regAddress)] : null,
        p.website ? ['公司官网', `<a href="${esc(p.website)}" target="_blank" rel="noopener" style="color:var(--primary)">${esc(p.website.replace(/^https?:\/\//, ''))}</a>`] : null,
      ].filter(Boolean);

      const points = (b.businessPoints || []).length
        ? `<ul class="biz-points">${b.businessPoints.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
        : (b.business ? `<p class="biz-desc">${esc(b.business)}</p>` : (b.introduction ? `<p class="biz-desc">${esc(String(b.introduction).slice(0, 400))}…</p>` : empty('数据源未提供该公司主营业务描述')));

      const structHtml = st ? `
        <div class="biz-struct">
          <div class="biz-struct-head">
            <span>最新报告期 <b>${esc(st.endDate || '--')}</b></span>
            <span>营业总收入 <b>${cnAmount(st.revenue)}</b></span>
            <span>毛利 <b>${cnAmount(st.grossProfit)}</b>（毛利率 ${st.grossMargin == null ? '--' : fmt(st.grossMargin) + '%'}）</span>
          </div>
          ${st.items.map((it) => {
            const w = it.pctOfRev === null ? 0 : Math.min(Math.abs(it.pctOfRev), 100);
            const tone = it.key === 'fin' && it.pctOfRev !== null && it.pctOfRev < 0 ? 'var(--up)' : 'var(--primary)';
            return `<div class="biz-bar">
              <span class="biz-bar-label">${esc(it.label)}</span>
              <div class="biz-bar-track"><div class="biz-bar-fill" style="width:${w}%;background:${tone}"></div></div>
              <span class="biz-bar-val">${cnAmount(it.value)} <span class="dim">/ ${it.pctOfRev === null ? '--' : fmt(Math.abs(it.pctOfRev)) + '%'}${it.key === 'fin' && it.pctOfRev !== null && it.pctOfRev < 0 ? '（利息收入大于支出）' : ''}</span></span>
            </div>`;
          }).join('')}
          <p class="dim-hint" style="margin:8px 0 0">${esc(b.segmentNote || '')}</p>
        </div>` : `<div class="dim-hint">暂未获取到最新报告期利润表，无法展示收入-成本费用结构。</div>`;

      setHtml('finBizSub', `数据日期 ${(b.updatedAt || '').slice(0, 10)} · 来源：${esc(b.source || '')}`);
      setHtml('finBizBody', `
        ${points}
        ${archive.length ? `<div class="biz-archive">${archive.map(([k, v]) => `<span class="biz-kv"><span class="k">${k}</span><span class="v">${v}</span></span>`).join('')}</div>` : ''}
        ${structHtml}`);
    } catch (e) {
      setHtml('finBizBody', errorBox(e.message));
    }
  }

  // ============================================================
  // 报告期选择器（核心指标 / 利润表 / 资产负债表 / 现金流量表 共用）
  // 注意：必须用 `#finPeriodBar .period-pill` 这样的完整选择器；
  // 早期版本误写成对象字符串拼接（finPeriodBar 少了 #），会静默匹配 0 个元素导致点击无反应。
  // ============================================================

  const PERIOD_BAR_ID = 'finPeriodBar';

  function periodBar(periods, withDate) {
    return `<div class="fin-periods" id="${PERIOD_BAR_ID}">
      <span class="period-bar-label">报告期</span>
      ${periods.map((p, i) => `
        <button type="button"
                class="period-pill ${i === state.periodIdx ? 'active' : ''}"
                data-p="${i}"
                title="${esc(p.endDate)} · ${esc(p.reportLabel)}"
                aria-pressed="${i === state.periodIdx}">${esc(p.reportLabel)}${withDate
          ? `<br><span class="dim" style="font-size:10px">${esc(p.endDate)}</span>` : ''}</button>`).join('')}
    </div>`;
  }

  /** 给当前页签的报告期药丸绑定点击（所有页签统一在 drawTab 末尾调用，避免漏绑） */
  function bindPeriodPills() {
    const bar = document.getElementById(PERIOD_BAR_ID);
    if (!bar) return;
    bar.querySelectorAll('.period-pill').forEach((el) => {
      el.addEventListener('click', () => selectPeriod(Number(el.dataset.p)));
    });
  }

  /** 选中某个报告期并立即按该期刷新内容 */
  function selectPeriod(idx) {
    const periods = (state.single && state.single.periods) || [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= periods.length) return;
    if (idx === state.periodIdx) return;
    state.periodIdx = idx;
    drawTab();               // 按所选报告期重新渲染
    scrollActiveColumn();    // 12 列时把选中的列滚入可视区
  }

  /** 让表格中被选中的报告期列滚入视口（表格横向可滚动） */
  function scrollActiveColumn() {
    const wrap = document.querySelector('#finTabBody .table-wrap');
    const cell = document.querySelector('#finTabBody th.col-active');
    if (!wrap || !cell) return;
    const w = wrap.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    if (c.left < w.left + 2 || c.right > w.right - 2) {
      wrap.scrollLeft += (c.left - w.left) - wrap.clientWidth / 2 + c.width / 2;
    }
  }

  function drawTab() {
    const d = state.single;
    if (!d) return;
    const periods = d.periods || [];
    if (!periods.length) { setHtml('finTabBody', empty('暂无财报数据')); return; }
    // 换标的或期数变化时，把索引夹回合法范围
    if (!Number.isInteger(state.periodIdx) || state.periodIdx < 0 || state.periodIdx >= periods.length) {
      state.periodIdx = 0;
    }

    if (state.tab === 'trend') { drawTrend(); return; }
    if (state.tab === 'core') renderCoreTab(periods); else renderStatementTab(periods);
    bindPeriodPills();
  }

  // ---------- 核心指标 ----------
  function renderCoreTab(periods) {
    // 口径说明：A 股财报为「年内累计」——一季报/半年报/三季报/年报。
    // color 说明：只有「变化率」类指标用涨跌色，比率与绝对量不加色以免误读。
    const rows = [
      { l: '营业总收入（累计）', fmt: 'amt', get: (p) => p.metrics.revenue },
      { l: '营业总收入（单季）', fmt: 'amt', get: (p) => p.single && p.single.revenue },
      { l: '归母净利润（累计）', fmt: 'amt', get: (p) => p.metrics.netProfit },
      { l: '归母净利润（单季）', fmt: 'amt', get: (p) => p.single && p.single.netProfit },
      { l: '销售毛利率', fmt: 'ratio', get: (p) => p.metrics.grossMargin },
      { l: '销售净利率', fmt: 'ratio', get: (p) => p.metrics.netMargin },
      { l: '净资产收益率', fmt: 'ratio', get: (p) => p.metrics.roe },
      { l: '总资产报酬率', fmt: 'ratio', get: (p) => p.metrics.roa },
      { l: '资产负债率', fmt: 'ratio', get: (p) => p.metrics.debtRatio },
      { l: '经营活动现金流净额（累计）', fmt: 'amt', get: (p) => p.metrics.operateCashFlow },
      { l: '经营现金流 / 净利润', fmt: 'x', get: (p) => p.metrics.cashToProfit },
      { l: '基本每股收益(元)', fmt: 'x', get: (p) => p.metrics.eps },
      { l: '营收同比', fmt: 'chg', get: (p) => p.metrics.revenueYoy },
      { l: '归母净利同比', fmt: 'chg', get: (p) => p.metrics.profitYoy },
      { l: '营收单季环比', fmt: 'chg', get: (p) => p.metrics.revenueQoq },
      { l: '归母净利单季环比', fmt: 'chg', get: (p) => p.metrics.profitQoq },
    ];
    const fmtCell = (v, t) => {
      if (v === null || v === undefined) return '<span class="dim">--</span>';
      if (t === 'amt') return cnAmount(v);
      if (t === 'ratio') return `<span class="strong">${fmt(v)}</span>`;
      if (t === 'chg') return `<span class="${cls(v)}">${pct(v)}</span>`;
      return fmt(v);
    };
    const cur = periods[state.periodIdx];
    const a = state.periodIdx;

    setHtml('finTabBody', `
      ${periodBar(periods, true)}
      <div class="period-summary">
        <div class="ps-head">当前所选报告期：<b>${esc(cur.reportLabel)}</b>
          <span class="dim">（${esc(cur.endDate)}）</span></div>
        <div class="ps-grid">
          <div class="ps-item"><span class="l">单季营业总收入</span><span class="v">${fmtCell(cur.single && cur.single.revenue, 'amt')}</span></div>
          <div class="ps-item"><span class="l">单季归母净利润</span><span class="v">${fmtCell(cur.single && cur.single.netProfit, 'amt')}</span></div>
          <div class="ps-item"><span class="l">销售毛利率</span><span class="v">${fmtCell(cur.metrics.grossMargin, 'ratio')}</span></div>
          <div class="ps-item"><span class="l">营收单季环比</span><span class="v">${fmtCell(cur.metrics.revenueQoq, 'chg')}</span></div>
          <div class="ps-item"><span class="l">归母净利同比</span><span class="v">${fmtCell(cur.metrics.profitYoy, 'chg')}</span></div>
        </div>
      </div>
      <div class="table-wrap"><table class="dt">
        <thead><tr><th>指标</th>${periods.map((p, i) =>
          `<th class="num ${i === a ? 'col-active' : ''}">${esc(p.reportLabel)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="metric-name">${esc(r.l)}</td>
          ${periods.map((p, i) => `<td class="num ${i === a ? 'col-active' : ''}">${fmtCell(r.get(p), r.fmt)}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>
      <p style="font-size:12px;color:var(--muted);margin:10px 0 0">
        点击上方报告期可切换高亮列并刷新「当前所选报告期」速览；切换页签后所选报告期会保持。
        A 股财报为<b>年内累计</b>（一季报 / 半年报 / 三季报 / 年报）；「单季」由相邻报告期累计值相减推导。
        同比＝与 4 个报告期前同期比较；单季环比＝与上一报告期单季值比较。数据来源：腾讯自选股数据接口。</p>`);
  }

  // ---------- 三大报表 ----------
  function renderStatementTab(periods) {
    const sectionKey = state.tab === 'income' ? 'income' : state.tab === 'balance' ? 'balance' : 'cash';
    const idx = state.periodIdx;
    const p = periods[idx];
    const a = idx;

    if (!p || !p[sectionKey] || !Object.keys(p[sectionKey]).length) {
      setHtml('finTabBody', `${periodBar(periods, false)}${empty('该报告期无此项数据')}`);
      return;
    }
    const entries = Object.entries(p[sectionKey]);
    const prev = periods[idx + 1];

    setHtml('finTabBody', `
      ${periodBar(periods, false)}
      <div class="table-wrap"><table class="dt">
        <thead><tr><th>项目</th><th class="num">金额 / 比率</th><th class="num">较上期</th></tr></thead>
        <tbody>${entries.map(([k, o]) => {
          const pv = prev && prev[sectionKey] && prev[sectionKey][k] ? prev[sectionKey][k].value : null;
          let delta = '<span class="dim">--</span>';
          if (typeof o.value === 'number' && typeof pv === 'number' && pv !== 0) {
            const ch = ((o.value - pv) / Math.abs(pv)) * 100;
            delta = `<span class="${cls(ch)}">${pct(ch)}</span>`;
          }
          const isRatio = /率|比率|周转|每股|倍数/.test(o.label);
          const val = typeof o.value === 'number'
            ? (isRatio ? fmt(o.value) : cnAmount(o.value))
            : (o.value === null ? '<span class="dim">--</span>' : esc(o.value));
          return `<tr><td class="metric-name">${esc(o.label)}</td><td class="num">${val}</td><td class="num">${delta}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <p style="font-size:12px;color:var(--muted);margin:10px 0 0">
        当前报告期 <b>${esc(p.endDate)}</b>（${esc(p.reportLabel)}）${prev ? `，较上期对比基准 ${esc(prev.endDate)}` : '，暂无更早一期可对比'}。
        比率类指标直接取自数据源，未做二次换算。</p>`);
    void a;
  }

  function drawTrend() {
    const d = state.single;
    const s = d.series || [];
    if (s.length < 2) { setHtml('finTabBody', empty('报告期数不足，无法绘制趋势')); return; }
    const labels = s.map((x) => x.label);

    setHtml('finTabBody', `
      <div class="chart-box h300"><canvas id="finChartProfit"></canvas></div>
      <div class="grid grid-2" style="margin-top:16px">
        <div class="chart-box h240"><canvas id="finChartMargin"></canvas></div>
        <div class="chart-box h240"><canvas id="finChartRoe"></canvas></div>
      </div>
      <div class="chart-box h240" style="margin-top:16px"><canvas id="finChartCash"></canvas></div>
      <p style="font-size:12px;color:var(--muted);margin:12px 0 0">
        上方为<b>单季口径</b>（由年内累计值相减推导），可消除累计口径造成的季节性锯齿；
        比率类与 ROE 指标为财报原文累计口径。</p>`);

    const amtDs = (label, key, color) => ({
      label, data: s.map((x) => (x[key] === null ? null : x[key] / 1e8)),
      borderColor: color, backgroundColor: color + '20',
      borderWidth: 2, tension: .3, pointRadius: 3, pointHoverRadius: 5, fill: true, spanGaps: true,
    });

    lineChart('finChartProfit', labels, [
      amtDs('单季营业总收入', 'revenue', UI.C.primary),
      amtDs('单季归母净利润', 'netProfit', UI.C.up),
    ], { plugins: { title: { display: true, text: '单季营收与净利润趋势（亿元）', color: '#1b2333', font: { size: 13 } } } });

    lineChart('finChartMargin', labels, [
      { label: '销售毛利率 %', data: s.map((x) => x.grossMargin), borderColor: '#8b5cf6', backgroundColor: '#8b5cf620', borderWidth: 2, tension: .3, pointRadius: 3 },
      { label: '销售净利率 %', data: s.map((x) => x.netMargin), borderColor: UI.C.up, backgroundColor: UI.C.up + '20', borderWidth: 2, tension: .3, pointRadius: 3 },
    ], { plugins: { title: { display: true, text: '盈利能力趋势（累计口径）', color: '#1b2333', font: { size: 13 } } } });

    lineChart('finChartRoe', labels, [
      { label: 'ROE %', data: s.map((x) => x.roe), borderColor: '#0ea5e9', backgroundColor: '#0ea5e920', borderWidth: 2, tension: .3, pointRadius: 3 },
      { label: '资产负债率 %', data: s.map((x) => x.debtRatio), borderColor: '#f59e0b', backgroundColor: '#f59e0b20', borderWidth: 2, tension: .3, pointRadius: 3 },
    ], { plugins: { title: { display: true, text: '股东回报与杠杆水平（累计口径）', color: '#1b2333', font: { size: 13 } } } });

    lineChart('finChartCash', labels, [
      { label: '单季经营活动现金流净额（亿元）', data: s.map((x) => (x.operateCashFlow === null ? null : x.operateCashFlow / 1e8)), borderColor: '#10b981', backgroundColor: '#10b98120', borderWidth: 2, tension: .3, pointRadius: 3, fill: true, spanGaps: true },
    ], { plugins: { title: { display: true, text: '单季经营现金流趋势', color: '#1b2333', font: { size: 13 } } } });
  }

  // ============================================================
  // 多公司对比
  // ============================================================
  async function renderCompare(force) {
    if (state.compare.length < 1) {
      setHtml('finCompare', `<div class="card">${empty('选择 2~4 家公司进行横向对比（在搜索框依次选择，或点击「载入自选股」）', '⚖️')}</div>`);
      return;
    }
    const key = state.compare.join(',');
    if (!force && state.compareData && state.compareKey === key) { drawCompare(); return; }
    setHtml('finCompare', `<div class="card">${UI.skeleton(6)}</div>`);
    try {
      state.compareData = await API.financeCompare(state.compare, 8);
      state.compareKey = key;
      drawCompare();
    } catch (e) {
      setHtml('finCompare', `<div class="card">${errorBox(e.message)}</div>`);
    }
  }

  const METRIC_GROUPS = {
    scale: { label: '规模与成长', keys: ['revenue', 'netProfit', 'revenueYoy', 'profitYoy'], max: 0 },
    profitability: { label: '盈利能力', keys: ['grossMargin', 'netMargin', 'roe', 'roa'], max: 100 },
    safety: { label: '财务稳健', keys: ['debtRatio', 'operateCashFlow', 'cashToProfit', 'eps'], max: 0 },
  };

  function drawCompare() {
    const d = state.compareData;
    const cs = d.companies || [];
    if (!cs.length) { setHtml('finCompare', `<div class="card">${empty('未获取到财报数据')}</div>`); return; }

    const head = `<div class="card">
      <div class="card-head"><h2>对比标的</h2><span class="card-sub">数据期：最新报告期 · 共 ${d.metrics.length} 项核心指标</span></div>
      <div class="fin-hero-quote" style="gap:20px">${cs.map((c) => `
        <div style="display:flex;flex-direction:column;gap:2px">
          <div style="font-weight:650">${esc(c.name)} <span class="dim mono" style="font-size:11px">${esc(c.code)}</span></div>
          <div style="font-size:11.5px;color:var(--muted)">最新期 ${esc(c.latestPeriod || '--')} · 评级
            <span class="grade grade-${esc(c.grade || 'C')}" style="width:auto;padding:0 6px;font-size:11px">${esc(c.grade || '-')}</span>
            评分 ${c.score === null || c.score === undefined ? '--' : c.score}</div>
        </div>`).join('')}</div>
    </div>`;

    const CHANGE_KEYS = ['revenueYoy', 'profitYoy'];
    const rows = d.metrics.map((m) => {
      const unit = m.unit === '元' ? '' : m.unit;
      const isChange = CHANGE_KEYS.includes(m.key);
      const cell = (v, i) => {
        if (v === null || v === undefined) return `<td class="num dim">--</td>`;
        const txt = m.unit === '元' ? cnAmount(v) : fmt(v);
        // 仅「变化率」类指标用涨跌色；比率与绝对量保持中性
        const tone = isChange ? cls(v) : '';
        return `<td class="num ${i === m.bestIdx ? 'best-cell' : ''} ${tone}">${txt}${i === m.bestIdx ? ' ★' : ''}</td>`;
      };
      return `<tr>
        <td class="metric-name">${esc(m.label)}<span class="metric-unit">${esc(unit)}</span></td>
        ${m.cells.map((v, i) => cell(v, i)).join('')}
        <td class="num dim">${m.avg === null ? '--' : (m.unit === '元' ? cnAmount(m.avg) : fmt(m.avg))}</td>
      </tr>`;
    }).join('');

    const table = `<div class="card">
      <div class="card-head"><h2>核心指标横向对比</h2><span class="card-sub">★ 标识该指标最优值（比率类越高越好，资产负债率为越低越好）</span></div>
      <div class="table-wrap"><table class="dt compare-table">
        <thead><tr><th>指标</th>${cs.map((c) => `<th class="num">${esc(c.name)}</th>`).join('')}<th class="num">均值</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;

    const chartCard = `<div class="grid grid-2">
      <div class="card"><div class="card-head"><h2>盈利能力雷达</h2><span class="card-sub">归一化 0-100</span></div>
        <div class="chart-box h320"><canvas id="finCompareRadar"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>营收规模对比</h2><span class="card-sub">最新报告期 · 亿元</span></div>
        <div class="chart-box h320"><canvas id="finCompareBar"></canvas></div></div>
    </div>`;

    const trendCard = `<div class="card">
      <div class="card-head"><h2>营收趋势对比</h2><span class="card-sub">近 8 个报告期 · 亿元</span></div>
      <div class="chart-box h300"><canvas id="finCompareTrend"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>归母净利润趋势对比</h2><span class="card-sub">近 8 个报告期 · 亿元</span></div>
      <div class="chart-box h300"><canvas id="finCompareTrendProfit"></canvas></div>
    </div>`;

    setHtml('finCompare', head + table + chartCard + trendCard);

    // 雷达：选取 5 个可比指标，按全样本极值归一到 0-100
    const RADAR = [
      { key: 'grossMargin', label: '毛利率', max: 100 },
      { key: 'netMargin', label: '净利率', max: 100 },
      { key: 'roe', label: 'ROE', max: 100 },
      { key: 'revenueYoy', label: '营收增速', max: 100 },
      { key: 'cashToProfit', label: '现金流/净利', max: 3 },
    ];
    const norm = (v, max) => (v === null || v === undefined ? 0 : Math.max(0, Math.min(100, (v / max) * 100)));
    radarChart('finCompareRadar', RADAR.map((r) => r.label),
      cs.map((c, i) => ({
        label: c.name,
        data: RADAR.map((r) => norm(c.metrics ? c.metrics[r.key] : null, r.max)),
        borderColor: UI.C.palette[i % UI.C.palette.length],
        backgroundColor: UI.C.palette[i % UI.C.palette.length] + '22',
        borderWidth: 2, pointRadius: 3,
      })), { max: 100, step: 25 });

    UI.barChart('finCompareBar', cs.map((c) => c.name), [{
      label: '营业总收入（亿元）',
      data: cs.map((c) => (c.metrics && c.metrics.revenue ? c.metrics.revenue / 1e8 : null)),
      backgroundColor: cs.map((_, i) => UI.C.palette[i % UI.C.palette.length] + 'cc'),
      borderRadius: 5, barPercentage: .6,
    }], { plugins: { legend: { display: false } } });

    const maxLen = Math.max(...cs.map((c) => (c.series || []).length));
    const labels = ((cs.find((c) => (c.series || []).length === maxLen) || {}).series || []).map((x) => x.label);
    const mk = (key) => cs.map((c, i) => {
      const map = {};
      (c.series || []).forEach((x) => { map[x.label] = x[key]; });
      return {
        label: c.name, data: labels.map((l) => (map[l] === undefined || map[l] === null ? null : map[l] / 1e8)),
        borderColor: UI.C.palette[i % UI.C.palette.length],
        backgroundColor: UI.C.palette[i % UI.C.palette.length] + '18',
        borderWidth: 2, tension: .3, pointRadius: 3, spanGaps: true,
      };
    });
    UI.lineChart('finCompareTrend', labels, mk('revenue'));
    UI.lineChart('finCompareTrendProfit', labels, mk('netProfit'));
  }

  // ============================================================
  // 披露日历
  // ============================================================
  async function renderCalendar(force) {
    if (!force && state.calendarData) { drawCalendar(state.calendarData); return; }
    setHtml('finCalendar', `<div class="card">${UI.skeleton(5)}</div>`);
    try {
      state.calendarData = await API.financeCalendar('hs', 60);
      drawCalendar(state.calendarData);
    } catch (e) {
      setHtml('finCalendar', `<div class="card">${errorBox(e.message)}</div>`);
    }
  }

  function drawCalendar(d) {
    {
      const list = d.list || [];
      if (!list.length) { setHtml('finCalendar', `<div class="card">${empty('暂无预约披露数据')}</div>`); return; }
      setHtml('finCalendar', `<div class="card">
        <div class="card-head"><h2>财报预约披露日历</h2><span class="card-sub">沪深市场 · 按披露日升序</span></div>
        <div class="table-wrap"><table class="dt">
          <thead><tr><th>披露日期</th><th>股票</th><th>代码</th><th class="num">距今天</th><th>状态</th></tr></thead>
          <tbody>${list.map((x) => `<tr>
            <td class="mono">${esc(x.date || '--')}</td>
            <td class="strong">${esc(x.name || '--')}</td>
            <td class="mono dim">${esc(x.code || '--')}</td>
            <td class="num">${x.daysLeft === null ? '--' : (x.daysLeft === 0 ? '<span class="tag tag-up">今日</span>' : x.daysLeft > 0 ? `${x.daysLeft} 天` : `已过 ${-x.daysLeft} 天`)}</td>
            <td>${x.daysLeft !== null && x.daysLeft <= 2 && x.daysLeft >= 0 ? UI.tag('即将披露', 'hot') : UI.tag(x.daysLeft < 0 ? '已披露' : '待披露', 'muted')}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p style="font-size:12px;color:var(--muted);margin:10px 0 0">开启「财报披露提醒」订阅后，披露前 2 日将自动推送到通知中心。</p>
      </div>`);
    }
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    initSearch();
    $$('#finModeSeg .seg-item').forEach((b) => b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      history.replaceState(null, '', `#finance/${state.mode}`);
      render();
    }));
    // 预取自选股，供默认标的与对比样本使用（不阻塞首屏）
    state.watchPromise = API.watchlist().catch(() => ({ list: [] }));
  }

  window.ViewFinance = { render, init };
})();
