/* modules/recommend.js — 推荐榜单视图 */
(function () {
  'use strict';
  const { $, $$, fmt, fmtInt, pct, cls, cnAmount, setHtml, esc, empty, errorBox, scoreColor, toast, tag } = UI;

  const state = { boards: null, boardId: 'comp', data: null, keyword: '' };
  const LS_KEY = 'fh.recommend.board';
  const PER_BOARD = 50;        // 每种榜单展示的股票数量

  async function render(sub, params) {
    bindOnce();

    if (!state.boards) {
      const d = await UI.task(() => API.recommendBoards(), { loadingText: '正在加载榜单目录…' });
      state.boards = d.boards || [];
      if (!state.boardId) state.boardId = state.boards[0] ? state.boards[0].id : 'comp';
    }

    const wanted = (params && params.board) || state.boardId;
    if (wanted && state.boards.some((b) => b.id === wanted)) state.boardId = wanted;

    drawTabs();
    try { localStorage.setItem(LS_KEY, state.boardId); } catch (_) { /* ignore */ }

    state.data = await UI.task(
      () => API.recommendBoard(state.boardId, PER_BOARD),
      { loadingText: `正在生成榜单与推荐理由（${PER_BOARD} 只）…` }
    );
    drawIntro();
    drawList();
  }

  function drawTabs() {
    setHtml('rcBoards', state.boards.map((b) => `
      <button type="button" class="board-tab ${b.id === state.boardId ? 'active' : ''}"
              data-id="${esc(b.id)}" style="--accent:${esc(b.accent)}">
        <span class="bt-label">${esc(b.label)}</span>
        <span class="bt-tag">${esc(b.tagline)}</span>
      </button>`).join(''));

    $$('#rcBoards .board-tab').forEach((el) => el.addEventListener('click', () => {
      if (el.dataset.id === state.boardId) return;
      state.boardId = el.dataset.id;
      history.replaceState(null, '', `#recommend?board=${state.boardId}`);
      drawTabs();
      setHtml('rcList', UI.skeleton(6));
      render(null, { board: state.boardId });
    }));
  }

  function drawIntro() {
    const d = state.data;
    if (!d) return;
    setHtml('rcIntro', `
      <div class="card-head">
        <h2>${esc(d.board.label)}</h2>
        <span class="card-sub">数据日期 ${esc(d.dataDate || '--')}</span>
      </div>
      <p class="rec-desc">${esc(d.board.desc)}</p>
      <div class="stat-strip">
        <span class="stat-item">样本范围 <b>${fmtInt(d.universe)}</b> 只</span>
        <span class="stat-item">排序依据 <b>${esc(d.board.sortMetricLabel || '—')}</b></span>
        <span class="stat-item">排序方向 <b>${d.sortedAsc ? '由低到高' : '由高到低'}</b></span>
        <span class="stat-item">本榜列出 <b>${d.list.length}</b> 只</span>
        <span class="stat-item dim">更新于 ${esc(new Date(d.updatedAt).toLocaleString('zh-CN'))}</span>
      </div>`);
  }

  /** 榜单工具条：条数统计 + 本榜筛选结果 */
  function drawSummary(shown) {
    const d = state.data;
    if (!d) return;
    const kw = state.keyword;
    setHtml('rcSummary', `
      <span class="stat-item">当前展示 <b>${shown.length}</b> 只</span>
      <span class="stat-item">本榜共 <b>${d.list.length}</b> 只（目标 ${d.wantLimit || PER_BOARD} 只）</span>
      ${kw ? `<span class="stat-item">筛选「<b>${esc(kw)}</b>」命中 <b>${shown.length}</b> 只</span>` : ''}
      <span class="stat-item dim">排序：${esc(d.board.sortMetricLabel || '—')} ${d.sortedAsc ? '升序' : '降序'}</span>`);
  }

  function scoreBars(scores) {
    // 注意：RiskScore 越高代表风险控制越好，故标签用「风控」避免被误读为风险高低
    const DIM = [
      { k: 'comp', label: '综合' }, { k: 'fundamental', label: '基本面' },
      { k: 'technical', label: '技术' }, { k: 'capital', label: '资金' }, { k: 'risk', label: '风控' },
    ];
    const has = DIM.some((x) => scores && scores[x.k] !== null && scores[x.k] !== undefined);
    if (!has) return '';
    return `<div class="score-bars">${DIM.map((x) => {
      const v = scores[x.k];
      const w = v === null || v === undefined ? 0 : Math.max(0, Math.min(100, v));
      return `<div class="sb-item" title="${esc(x.label)}评分 ${v === null || v === undefined ? '--' : v}${x.k === 'risk' ? '（分数越高代表风险控制越好）' : ''}">
        <span class="sb-label">${esc(x.label)}</span>
        <span class="sb-track"><span class="sb-fill" style="width:${w}%;background:${scoreColor(v === null || v === undefined ? null : v / 10)}"></span></span>
        <span class="sb-val">${v === null || v === undefined ? '--' : Math.round(v)}</span>
      </div>`;
    }).join('')}</div>`;
  }

  function metricChips(list) {
    if (!list || !list.length) return '';
    const GROWTH_KEYS = ['RevenueGrowth', 'NetProfitGrowth', 'OperatingProfitGrowth', 'AssetGrowth', 'DIV_TTM'];
    const INT_KEYS = ['MainInDays', 'MainOutDays', 'NorthAppearM'];
    return `<div class="metric-chips">${list.map((m) => {
      // money：数据源资金/现金流字段单位为「万元」，换算为「元」后统一显示为亿/万
      let v;
      if (m.money) v = cnAmount(m.value * 1e4);
      else if (m.unit === '%') v = pct(m.value);
      else if (INT_KEYS.includes(m.key)) v = String(Math.round(m.value));
      else v = fmt(m.value, 2);
      const unit = (m.money || m.unit === '%') ? '' : esc(m.unit);
      const tone = m.key === 'MainNetIn' ? cls(m.value)
        : (GROWTH_KEYS.includes(m.key) ? cls(m.value) : '');
      return `<span class="metric-chip"><span class="mc-l">${esc(m.label)}</span><span class="mc-v ${tone}">${v}${unit}</span></span>`;
    }).join('')}</div>`;
  }

  function drawList() {
    const d = state.data;
    if (!d) return;
    const shown = state.keyword
      ? d.list.filter((x) => String(x.name).toLowerCase().includes(state.keyword)
        || String(x.code).toLowerCase().includes(state.keyword))
      : d.list;
    drawSummary(shown);

    if (!shown.length) {
      setHtml('rcList', `<div class="card">${empty(state.keyword ? '本榜单中没有匹配的股票' : '该榜单暂无数据')}</div>`);
      return;
    }

    setHtml('rcList', shown.map((x) => `
      <article class="rec-card" style="--accent:${esc(d.board.accent)}">
        <div class="rec-head">
          <span class="rec-rank ${x.rank <= 3 ? 'top' : ''}">${x.rank}</span>
          <div class="rec-id">
            <div class="rec-name">${esc(x.name)}
              <span class="rec-code mono">${esc(x.code)}</span>
            </div>
            ${x.market ? `<div class="rec-market dim">${esc(x.market)}</div>` : ''}
          </div>
          <div class="rec-price">
            <div class="rp-val ${cls(x.changePct)}">${fmt(x.price)}</div>
            <div class="rp-chg ${cls(x.changePct)}">${pct(x.changePct)}</div>
          </div>
          <button class="btn btn-sm btn-primary rec-go" data-code="${esc(x.code)}" data-name="${esc(x.name)}">查看财报</button>
        </div>

        ${scoreBars(x.scores)}
        ${metricChips(x.metricList)}

        <div class="rec-why">
          <div class="rw-title">推荐理由</div>
          <ul class="rw-list">${(x.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="dim">暂无</li>'}</ul>
        </div>

        ${(x.risks || []).length ? `<div class="rec-risk">
          <div class="rw-title">风险提示</div>
          <ul class="rw-list">${x.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        </div>` : ''}

        <div class="rec-foot">
          <span class="dim">${x.marketCap !== null && x.marketCap !== undefined ? `总市值 ${cnAmount(x.marketCap * 1e8)}` : ''}</span>
          <span class="dim">${x.turnoverRate !== null && x.turnoverRate !== undefined ? `换手率 ${fmt(x.turnoverRate)}%` : ''}</span>
        </div>
      </article>`).join('')
      + `<div class="rec-disclaimer">⚠️ ${esc(d.disclaimer)}</div>`);

    $$('#rcList .rec-go').forEach((b) => b.addEventListener('click', () => {
      App.openStock(b.dataset.code, b.dataset.name);
    }));
    $$('#rcList .rec-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.rec-go')) return;
        const btn = card.querySelector('.rec-go');
        if (btn) App.openStock(btn.dataset.code, btn.dataset.name);
      });
    });
  }

  function bindOnce() {
    const btn = $('#rcRefresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        API.clearCache().catch(() => {});
        setHtml('rcList', UI.skeleton(6));
        render(null, { board: state.boardId });
      });
    }

    const inp = $('#rcFilter');
    if (inp && !inp.dataset.bound) {
      inp.dataset.bound = '1';
      let t = null;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { state.keyword = inp.value.trim().toLowerCase(); drawList(); }, 160);
      });
    }
  }

  function init() {
    bindOnce();
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) state.boardId = saved;
    } catch (_) { /* ignore */ }
  }

  window.ViewRecommend = { render, init };
})();
