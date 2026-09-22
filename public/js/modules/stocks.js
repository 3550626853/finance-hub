/* modules/stocks.js — 股票列表视图（按分类浏览，点击进入财报整理） */
(function () {
  'use strict';
  const { $, $$, fmt, fmtInt, pct, cls, cnAmount, setHtml, esc, empty, errorBox, toast } = UI;

  const PAGE = 40;
  const state = {
    catalog: null,
    dim: 'index',
    groupCode: null,
    groupName: null,
    keyword: '',
    sort: 'changePct',
    order: 'desc',
    offset: 0,
    data: null,
  };

  // ============================================================
  // 入口
  // ============================================================
  async function render(sub, params) {
    if (params && params.dim) state.dim = params.dim;
    if (params && params.code) state.groupCode = params.code;
    if (params && params.sort) {
      const [s, o] = String(params.sort).split('-');
      if (s) { state.sort = s; state.order = o || 'desc'; }
    }

    if (!state.catalog) {
      state.catalog = await UI.task(() => API.stockCatalog(), { loadingText: '正在构建股票分类目录…' });
      // 校验 URL 传入的维度是否存在，不存在则回落到第一个维度
      if (!state.catalog.dimensions.some((d) => d.key === state.dim)) {
        state.dim = state.catalog.dimensions[0] ? state.catalog.dimensions[0].key : 'index';
      }
    }
    bindOnce();
    drawDimTabs();
    drawGroups();

    // 校验当前分类确实属于目标维度：否则清空（避免沿用上一个维度的分类代码，
    // 例如从「宽基指数」切到「申万一级行业」时仍带着 sh000300 去请求行业成分股而失败）
    const dimObj = state.catalog.dimensions.find((d) => d.key === state.dim);
    if (state.groupCode && !(dimObj && dimObj.groups.some((g) => g.code === state.groupCode))) {
      state.groupCode = null;
      state.groupName = null;
    }
    if (!state.groupCode) {
      const first = dimObj && dimObj.groups[0];
      state.groupCode = first ? first.code : null;
      state.groupName = first ? first.name : null;
      drawGroups();                 // 补一次，让默认选中的分类显示高亮
    }

    if (state.groupCode) await loadList(false);
    else setHtml('stkTable', empty('该维度下暂无分类'));
  }

  // ============================================================
  // 维度与分类
  // ============================================================
  function drawDimTabs() {
    const dims = state.catalog.dimensions || [];
    setHtml('stkDimSeg', dims.map((d) =>
      `<button class="seg-item ${d.key === state.dim ? 'active' : ''}" data-dim="${esc(d.key)}">${esc(d.label)}</button>`).join(''));

    $$('#stkDimSeg .seg-item').forEach((b) => {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        state.dim = b.dataset.dim;
        state.groupCode = null;      // 切维度后自动落到该维度第一个分类
        state.groupName = null;
        state.offset = 0;
        state.keyword = '';
        const inp = $('#stkFilter');
        if (inp) inp.value = '';
        history.replaceState(null, '', `#stocks?dim=${state.dim}`);
        drawDimTabs();
        const dim = state.catalog.dimensions.find((d) => d.key === state.dim);
        if (dim && dim.groups[0]) {
          state.groupCode = dim.groups[0].code;
          state.groupName = dim.groups[0].name;
        }
        drawGroups();
        setHtml('stkTable', `<div class="table-skeleton">${UI.skeleton(8)}</div>`);
        setHtml('stkStats', '');
        loadList(false);
      });
    });

    const dim = dims.find((d) => d.key === state.dim);
    setHtml('stkDimHint', dim ? `${esc(dim.label)}：${esc(dim.hint)} · 共 ${dim.groups.length} 个分类` : '');
  }

  function drawGroups() {
    const dim = state.catalog.dimensions.find((d) => d.key === state.dim);
    if (!dim || !dim.groups.length) { setHtml('stkGroups', empty('暂无分类')); return; }

    setHtml('stkGroups', dim.groups.map((g) => {
      const active = g.code === state.groupCode;
      const chg = g.changePct;
      return `<button type="button" class="catalog-item ${active ? 'active' : ''}" data-code="${esc(g.code)}" data-name="${esc(g.name)}">
        <span class="ci-name">${esc(g.name)}</span>
        ${g.subtitle ? `<span class="ci-sub">${esc(g.subtitle)}</span>` : ''}
        ${chg !== null && chg !== undefined ? `<span class="ci-chg ${cls(chg)}">${pct(chg)}</span>` : ''}
      </button>`;
    }).join(''));

    $$('#stkGroups .catalog-item').forEach((el) => el.addEventListener('click', () => {
      state.groupCode = el.dataset.code;
      state.groupName = el.dataset.name;
      state.offset = 0;
      history.replaceState(null, '', `#stocks?dim=${state.dim}&code=${encodeURIComponent(state.groupCode)}`);
      drawGroups();
      // 局部骨架屏，避免切换分类时全屏遮罩打断浏览
      setHtml('stkTable', `<div class="table-skeleton">${UI.skeleton(8)}</div>`);
      setHtml('stkStats', '');
      loadList(false);
    }));
  }

  // ============================================================
  // 股票列表
  // ============================================================
  async function loadList(showLoading) {
    if (!state.groupCode) return;
    const opts = {
      kind: state.dim, code: state.groupCode, q: state.keyword,
      sort: state.sort, order: state.order, limit: PAGE, offset: state.offset,
    };
    try {
      state.data = await (showLoading
        ? UI.task(() => API.stockList(opts), { loadingText: '正在拉取成分股行情…' })
        : API.stockList(opts));
    } catch (e) {
      setHtml('stkTable', errorBox(e.message));
      setHtml('stkStats', '');
      setHtml('stkPager', '');
      return;
    }
    drawList();
  }

  function drawList() {
    const d = state.data;
    if (!d) return;

    setHtml('stkListTitle', `${esc(d.name || state.groupName || '股票列表')} · 成分股`);
    setHtml('stkListSub', `数据日期 ${esc((d.updatedAt || '').slice(0, 10))} · 点击任意股票进入其财报整理界面`);

    const s = d.stats || {};
    setHtml('stkStats', `
      <span class="stat-item">成分股 <b>${fmtInt(d.total)}</b> 只</span>
      <span class="stat-item up">上涨 <b>${fmtInt(s.up)}</b></span>
      <span class="stat-item down">下跌 <b>${fmtInt(s.down)}</b></span>
      <span class="stat-item">平盘 <b>${fmtInt(s.flat)}</b></span>
      <span class="stat-item">涨停 <b>${fmtInt(s.limitUp)}</b></span>
      <span class="stat-item">平均涨跌 <b class="${cls(s.avgChangePct)}">${pct(s.avgChangePct)}</b></span>
      <span class="stat-item">中位涨跌 <b class="${cls(s.medianChangePct)}">${pct(s.medianChangePct)}</b></span>
      ${d.declaredCount && d.declaredCount !== d.total ? `<span class="stat-item dim">上游声明 ${d.declaredCount} 只</span>` : ''}`);

    // 模拟数据提示（当前仅港股板块使用，替换真实数据后由后端 mock 标记自动消失）
    setHtml('stkMockNote', d.mock
      ? `<div class="dim-hint">⚠️ 当前分类为<b>模拟数据</b>：行情与估值为占位样例（字段结构与真实数据一致），仅用于展示与交互验证；点击股票跳转的财报为该股真实数据。接入方式见 <span class="mono">lib/hk-mock.js</span>。</div>`
      : '');

    if (!d.list.length) { setHtml('stkTable', empty('没有匹配的股票')); setHtml('stkPager', ''); return; }

    setHtml('stkTable', `<table class="dt">
      <thead><tr>
        <th>#</th><th>股票名称</th><th>股票代码</th><th class="num">当前价</th><th class="num">涨跌额</th>
        <th class="num">涨跌幅</th><th class="num">换手率</th><th class="num">总市值</th><th class="num">PE</th><th></th>
      </tr></thead>
      <tbody>${d.list.map((x, i) => `<tr class="row-click" data-code="${esc(x.code)}">
        <td class="dim">${state.offset + i + 1}</td>
        <td><span class="strong">${esc(x.name)}</span></td>
        <td class="mono dim">${esc(x.code)}</td>
        <td class="num strong ${cls(x.changePct)}">${fmt(x.price)}</td>
        <td class="num ${cls(x.changePct)}">${x.price === null || x.changePct === null ? '--' : ((x.price * x.changePct / (100 + x.changePct)) >= 0 ? '+' : '') + fmt(x.price * x.changePct / (100 + x.changePct))}</td>
        <td class="num ${cls(x.changePct)}">${pct(x.changePct)}</td>
        <td class="num">${x.turnoverRate === null ? '--' : fmt(x.turnoverRate) + '%'}</td>
        <td class="num">${cnAmount(x.marketCap === null ? null : x.marketCap * 1e8)}</td>
        <td class="num">${fmt(x.pe)}</td>
        <td class="num"><span class="link-cell">财报 →</span></td>
      </tr>`).join('')}</tbody></table>`);

    $$('#stkTable tr.row-click').forEach((tr) => tr.addEventListener('click', () => {
      const code = tr.dataset.code;
      const name = (d.list.find((x) => x.code === code) || {}).name;
      App.openStock(code, name);
    }));

    drawPager(d);
  }

  function drawPager(d) {
    const pages = Math.max(1, Math.ceil(d.total / PAGE));
    const cur = Math.floor(state.offset / PAGE) + 1;
    if (d.total <= PAGE) { setHtml('stkPager', ''); return; }
    setHtml('stkPager', `
      <button class="btn btn-sm" data-page="first" ${cur === 1 ? 'disabled' : ''}>首页</button>
      <button class="btn btn-sm" data-page="prev" ${cur === 1 ? 'disabled' : ''}>上一页</button>
      <span class="pager-info">第 <b>${cur}</b> / ${pages} 页 · 共 ${fmtInt(d.total)} 只</span>
      <button class="btn btn-sm" data-page="next" ${cur === pages ? 'disabled' : ''}>下一页</button>
      <button class="btn btn-sm" data-page="last" ${cur === pages ? 'disabled' : ''}>末页</button>`);

    $$('#stkPager .btn').forEach((b) => b.addEventListener('click', () => {
      const p = b.dataset.page;
      if (p === 'first') state.offset = 0;
      else if (p === 'prev') state.offset = Math.max(0, state.offset - PAGE);
      else if (p === 'next') state.offset = Math.min((pages - 1) * PAGE, state.offset + PAGE);
      else if (p === 'last') state.offset = (pages - 1) * PAGE;
      loadList(true).then(() => {
        const el = document.getElementById('stkListTitle');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }));
  }

  // ============================================================
  // 事件绑定（只绑一次）
  // ============================================================
  function bindOnce() {
    // 维度页签由 drawDimTabs() 动态渲染并绑定，此处只处理筛选与排序
    const inp = $('#stkFilter');
    if (inp && !inp.dataset.bound) {
      inp.dataset.bound = '1';
      let t = null;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          state.keyword = inp.value.trim();
          state.offset = 0;
          loadList(false);
        }, 260);
      });
    }

    const sel = $('#stkSort');
    if (sel && !sel.dataset.bound) {
      sel.dataset.bound = '1';
      sel.addEventListener('change', () => {
        const [s, o] = sel.value.split('-');
        state.sort = s; state.order = o;
        state.offset = 0;
        loadList(true);
      });
    }
  }

  function init() { bindOnce(); }

  window.ViewStocks = { render, init };
})();
