/* modules/picker.js — AI 选股指南视图 */
(function () {
  'use strict';
  const { $, $$, fmt, fmtInt, pct, cls, cnAmount, setHtml, esc, empty, errorBox, toast, tag } = UI;

  const state = { tab: 'daily', profile: localStorage.getItem('fh.picker.profile') || 'balanced', daily: null, holdings: null, portfolio: null, watchQuotes: null };

  // ============================================================
  // 入口
  // ============================================================
  /** 同步激进度选项的选中态（选中图标 / 高亮胶囊必须跟随 state.profile） */
  function syncProfileSeg() {
    $$('#pkProfileSeg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.profile === state.profile));
  }

  async function render(sub) {
    bindOnce();
    if (sub && ['daily', 'holdings', 'manage'].includes(sub)) state.tab = sub;
    $$('#pkSeg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    syncProfileSeg();
    $('#pkDaily').hidden = state.tab !== 'daily';
    $('#pkHoldings').hidden = state.tab !== 'holdings';
    $('#pkManage').hidden = state.tab !== 'manage';

    if (state.tab === 'daily') return renderDaily();
    if (state.tab === 'holdings') return renderHoldings();
    return renderManage();
  }

  function switchTab(tab) {
    state.tab = tab;
    App.go('picker', { sub: tab, force: true });
  }

  // ============================================================
  // 一、今日推荐（按激进度档案差异化）
  // ============================================================
  const PROFILE_INTRO = {
    conservative: { label: '保守型', tagline: '控制回撤优先，宁缺毋滥', desc: '以基本面质量与风控评分为核心，只选财务扎实、波动可控的标的；对估值、换手与短线热度施加更严格的排除条件。适合低风险承受能力的投资者。', accent: '#0f9d58' },
    balanced: { label: '稳健型', tagline: '均衡口径，攻守兼备', desc: '以综合评分（覆盖基本面 / 技术 / 资金 / 风控四维）为主轴的均衡口径，趋势与质量并重。适合大多数投资者的默认选择。', accent: '#2563eb' },
    aggressive: { label: '进取型', tagline: '追逐动量与资金，容忍波动', desc: '以技术结构与主力资金为主轴，捕捉强势动量标的；放宽估值与短期热度限制，接受更高波动。适合风险承受能力强、纪律执行到位的投资者。', accent: '#d92b2b' },
  };

  async function renderDaily({ force = false } = {}) {
    setHtml('pkProfileIntro', '');
    setHtml('pkKpis', '');
    setHtml('pkFunnel', '');
    setHtml('pkList', `<div class="card">${UI.skeleton(8)}</div>`);
    try {
      const d = force ? await UI.task(() => API.runPicker(state.profile), { loadingText: '正在重新运行选股分析（约 10–30 秒）…' })
        : await API.pickerDaily(state.profile);
      state.daily = d;
      const intro = PROFILE_INTRO[d.profile && d.profile.key] || PROFILE_INTRO.balanced;
      setHtml('pkProfileIntro', `<span class="tag" style="background:${(d.profile && d.profile.accent) || intro.accent};color:#fff;border:0">${esc(d.profile ? d.profile.label : intro.label)}</span>
        <b>${esc(d.profile ? d.profile.tagline : '')}</b> —— ${esc(d.profile ? d.profile.desc : intro.desc)}
        <span style="display:block;margin-top:6px">⚖️ <b>仓位纪律</b>：${esc(d.profile ? d.profile.positionHint : '')}</span>`);
      drawDailyKpis(d);
      drawFunnel(d);
      drawPicks(d);
    } catch (e) {
      setHtml('pkList', `<div class="card">${errorBox(e.message)}</div>`);
    }
  }

  function drawDailyKpis(d) {
    const w = d.profile && d.profile.weights || d.weights || {};
    const WN = { comp: '综合', fun: '基本面', tec: '技术', cap: '资金', risk: '风控' };
    setHtml('pkKpis', `
      <div class="kpi" style="border-top:3px solid ${(d.profile && d.profile.accent) || '#7c3aed'}">
        <div class="kpi-label">当前档位</div>
        <div class="kpi-value" style="font-size:17px">${esc(d.profile ? d.profile.label : '--')}</div>
        <div class="kpi-foot">${esc(d.profile ? d.profile.riskFocus : '')} · 上限 ${d.list ? (d.profile && d.profile.targetMax || d.count) : '--'} 只</div>
      </div>
      <div class="kpi k-up">
        <div class="kpi-label">今日推荐</div>
        <div class="kpi-value">${fmtInt(d.count)}<small>只</small></div>
        <div class="kpi-foot">目标 ${d.target} 只 · 范围 3–10 只</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">初筛池</div>
        <div class="kpi-value">${fmtInt(d.poolSize)}<small>只</small></div>
        <div class="kpi-foot">全市场综合评分前 ${fmtInt(d.universe)} 名</div>
      </div>
      <div class="kpi k-warn">
        <div class="kpi-label">过滤口径</div>
        <div class="kpi-value" style="font-size:17px">${esc(d.tier)}</div>
        <div class="kpi-foot">${esc(d.tierDesc)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">排除风险标的</div>
        <div class="kpi-value">${fmtInt(d.excludedCount)}<small>只</small></div>
        <div class="kpi-foot">ST / 涨停 / 超买 / 破上轨${d.profile && d.profile.key === 'conservative' ? ' / 高换手 / 高估值' : ''}等</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">数据日期</div>
        <div class="kpi-value" style="font-size:17px">${esc(d.date)}</div>
        <div class="kpi-foot">${d.cached ? `${esc(d.profile ? d.profile.label : '')}当日缓存` : `生成于 ${new Date(d.generatedAt).toLocaleTimeString('zh-CN')}`}</div>
      </div>`);
    setHtml('pkDailyMeta', `权重：${Object.entries(w).map(([k, v]) => `${WN[k]} ${Math.round(v * 100)}%`).join(' · ')}`);
  }

  function drawFunnel(d) {
    const f = d.funnel || [];
    if (!f.length) { setHtml('pkFunnel', ''); return; }
    setHtml('pkFunnel', `<div class="pk-funnel">
      ${f.map((x) => `<div class="pkf-item ${x.passed >= 3 ? 'ok' : ''}">
        <span class="pkf-tier">${esc(x.tier)}口径</span>
        <span class="pkf-desc">${esc(x.desc)}</span>
        <span class="pkf-count">通过 <b>${x.passed}</b> 只</span>
      </div>`).join('')}
    </div>`);
  }

  function drawPicks(d) {
    if (!d.list || !d.list.length) {
      setHtml('pkList', `<div class="card">${empty('今日过滤后无符合条件标的（弱市属正常现象，可点击「立即重新分析」或明日再看）', '✦')}</div>`);
      return;
    }
    setHtml('pkList', d.list.map((x) => `
      <article class="rec-card pk-card" style="--accent:${esc((d.profile && d.profile.accent) || '#7c3aed')}">
        <div class="rec-head">
          <span class="rec-rank ${x.rank <= 3 ? 'top' : ''}">${x.rank}</span>
          <div class="rec-id">
            <div class="rec-name">${esc(x.name)}<span class="rec-code mono">${esc(x.code)}</span></div>
            <div class="rec-market dim">量化综合分 <b>${x.pickScore}</b> / 105</div>
          </div>
          <div class="rec-price">
            <div class="rp-val ${cls(x.changePct)}">${fmt(x.price)}</div>
            <div class="rp-chg ${cls(x.changePct)}">${pct(x.changePct)}</div>
          </div>
          <div class="card-tools">
            <button class="btn btn-sm btn-ghost pk-watch" data-code="${esc(x.code)}" data-name="${esc(x.name)}">＋自选</button>
            <button class="btn btn-sm btn-primary rec-go" data-code="${esc(x.code)}" data-name="${esc(x.name)}">查看财报</button>
          </div>
        </div>

        <div class="pk-ref">
          ${x.ref.support ? `<span class="pkr"><span class="l">MA20 支撑</span><b>${fmt(x.ref.support)}</b></span>` : ''}
          ${x.ref.resistance ? `<span class="pkr"><span class="l">布林上轨（压力参考）</span><b>${fmt(x.ref.resistance)}</b></span>` : ''}
          ${x.ref.stopLoss ? `<span class="pkr warn"><span class="l">止损参考（MA20×0.97）</span><b>${fmt(x.ref.stopLoss)}</b></span>` : ''}
          <span class="pkr"><span class="l">换手率</span><b>${x.turnoverRate == null ? '--' : fmt(x.turnoverRate) + '%'}</b></span>
          <span class="pkr"><span class="l">总市值</span><b>${x.marketCap == null ? '--' : cnAmount(x.marketCap * 1e8)}</b></span>
        </div>

        <div class="rec-why">
          <div class="rw-title">入选理由</div>
          <ul class="rw-list">${(x.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="dim">暂无</li>'}</ul>
        </div>
        ${(x.risks || []).length ? `<div class="rec-risk">
          <div class="rw-title">风险提示</div>
          <ul class="rw-list">${x.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        </div>` : ''}
      </article>`).join('')
      + `<div class="rec-disclaimer">⚠️ ${esc(d.disclaimer)}</div>`);

    $$('#pkList .rec-go').forEach((b) => b.addEventListener('click', () => App.openStock(b.dataset.code, b.dataset.name)));
    $$('#pkList .pk-watch').forEach((b) => b.addEventListener('click', async () => {
      try {
        await API.addWatch(b.dataset.code);
        toast(`已加入自选：${b.dataset.name}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }));
  }

  // ============================================================
  // 二、持仓分析
  // ============================================================
  async function renderHoldings({ force = false } = {}) {
    setHtml('pkHKpis', '');
    setHtml('pkHList', `<div class="card">${UI.skeleton(6)}</div>`);
    try {
      const d = await UI.task(() => API.holdingsAnalysis(), { loadingText: '正在对持仓逐只分析（含财报质量评分，约 5–20 秒）…' });
      state.holdings = d;
      if (!d.total) {
        setHtml('pkHKpis', '');
        setHtml('pkHList', `<div class="card">${empty('暂无持仓记录。请切换到「自选与持仓」页签添加持仓，或直接记一笔买入交易。', '🗂')}</div>`);
        return;
      }
      drawHKpis(d);
      drawHoldings(d);
    } catch (e) {
      setHtml('pkHList', `<div class="card">${errorBox(e.message)}</div>`);
    }
  }

  function drawHKpis(d) {
    const s = d.summary;
    setHtml('pkHKpis', `
      <div class="kpi">
        <div class="kpi-label">持仓数量</div>
        <div class="kpi-value">${fmtInt(s.holdings)}<small>只</small></div>
        <div class="kpi-foot">分析于 ${new Date(d.updatedAt).toLocaleTimeString('zh-CN')}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">持仓成本 / 市值</div>
        <div class="kpi-value" style="font-size:17px">${cnAmount(s.totalCost)}<small class="down" style="font-size:13px"> / ${cnAmount(s.totalValue)}</small></div>
        <div class="kpi-foot">按最新收盘价估算</div>
      </div>
      <div class="kpi ${s.totalPnl >= 0 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">浮动盈亏</div>
        <div class="kpi-value">${s.totalPnl >= 0 ? '+' : ''}${cnAmount(s.totalPnl)}<small>（${s.totalPnlPct >= 0 ? '+' : ''}${fmt(s.totalPnlPct)}%）</small></div>
        <div class="kpi-foot">当日估算盈亏 ${s.dayPnl >= 0 ? '+' : ''}${cnAmount(s.dayPnl)}</div>
      </div>
      <div class="kpi k-down">
        <div class="kpi-label">建议卖出 / 减仓</div>
        <div class="kpi-value">${fmtInt(s.sellCount)}<small class="down" style="font-size:13px"> / ${fmtInt(s.reduceCount)}</small></div>
        <div class="kpi-foot">关注 ${s.watchCount} 只 · 持有 ${s.holdCount} 只</div>
      </div>`);
  }

  function drawHoldings(d) {
    const VERDICT_TAG = { '建议卖出': 'down', '建议减仓': 'warn', '关注': 'muted', '继续持有': 'up' };
    setHtml('pkHList', d.list.map((x) => `
      <article class="card pk-hold">
        <div class="rec-head">
          <span class="pk-health" style="background:${healthColor(x.health)}">${x.health}</span>
          <div class="rec-id">
            <div class="rec-name">${esc(x.name)}<span class="rec-code mono">${esc(x.code)}</span></div>
            <div class="rec-market dim">持有 ${fmtInt(x.qty)} 股 · 成本 ${fmt(x.cost)} · ${tag(x.verdict, VERDICT_TAG[x.verdict] || 'muted')}</div>
          </div>
          <div class="rec-price">
            <div class="rp-val ${cls(x.dayChangePct)}">${fmt(x.price)}</div>
            <div class="rp-chg">${x.pnlPct === null ? '--' : `<span class="${cls(x.pnlPct)}">${x.pnlPct >= 0 ? '+' : ''}${fmt(x.pnlPct)}%</span>`}</div>
          </div>
          <div class="pk-hstat">
            <div><span class="l">市值</span><b>${x.marketValue === null ? '--' : cnAmount(x.marketValue)}</b></div>
            <div><span class="l">浮动盈亏</span><b class="${cls(x.pnl)}">${x.pnl === null ? '--' : (x.pnl >= 0 ? '+' : '') + cnAmount(x.pnl)}</b></div>
            <div><span class="l">财报评分</span><b>${x.finScore === null ? '--' : `${x.finScore} / 10（${esc(x.finGrade)}）`}</b></div>
          </div>
          <div class="card-tools">
            <button class="btn btn-sm btn-ghost pk-go" data-code="${esc(x.code)}" data-name="${esc(x.name)}">财报</button>
          </div>
        </div>
        <div class="pk-signals">
          <div class="rw-title">卖出 / 风险信号（${(x.signals || []).length} 条）</div>
          ${(x.signals || []).length ? x.signals.map((s) => `
            <div class="sig-item lv-${esc(s.level)}"><span class="sig-id">${esc(s.id)}</span><b>${esc(s.label)}</b><span>${esc(s.text)}</span></div>`).join('')
            : '<div class="dim" style="font-size:12.5px;padding:4px 0">未触发任何卖出信号</div>'}
          ${(x.holds || []).length ? `
            <div class="rw-title" style="margin-top:10px">继续持有的依据</div>
            <ul class="rw-list">${x.holds.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
          <div class="pk-ref" style="margin-top:10px">
            ${x.ref.ma20 ? `<span class="pkr"><span class="l">MA20</span><b>${fmt(x.ref.ma20)}</b></span>` : ''}
            ${x.ref.stop ? `<span class="pkr warn"><span class="l">止损参考（MA20×0.97）</span><b>${fmt(x.ref.stop)}</b></span>` : ''}
          </div>
        </div>
      </article>`).join('')
      + `<div class="rec-disclaimer">⚠️ ${esc(d.disclaimer)}</div>`);

    $$('#pkHList .pk-go').forEach((b) => b.addEventListener('click', () => App.openStock(b.dataset.code, b.dataset.name)));
  }

  function healthColor(v) {
    if (v >= 8) return 'var(--up)';
    if (v >= 6) return '#0ea5e9';
    if (v >= 4) return '#f59e0b';
    return 'var(--down)';
  }

  // ============================================================
  // 三、自选与持仓管理
  // ============================================================
  async function renderManage() {
    setHtml('pkWatchList', UI.skeleton(4));
    setHtml('pkHoldingsList', UI.skeleton(3));
    setHtml('pkTxList', UI.skeleton(4));
    try {
      state.portfolio = await API.portfolio();
      await Promise.all([drawWatch(), drawHoldingsTable(), drawTx()]);
    } catch (e) {
      setHtml('pkWatchList', errorBox(e.message));
    }
  }

  // ---- 自选股 ----
  async function drawWatch() {
    const list = state.portfolio.watchlist || [];
    if (!list.length) {
      setHtml('pkWatchList', `<div class="pad">${empty('自选股为空：输入代码或名称后点击「加入自选」', '★')}</div>`);
      return;
    }
    setHtml('pkWatchList', '<div class="dim-hint">正在获取自选行情…</div>');
    const q = await fetchQuotesSafe(list);
    state.watchQuotes = q;
    setHtml('pkWatchList', `<table class="dt">
      <thead><tr><th>名称 / 代码</th><th class="num">现价</th><th class="num">涨跌幅</th><th class="num">总市值</th><th class="num">操作</th></tr></thead>
      <tbody>${list.map((c) => {
        const x = q[c] || {};
        return `<tr>
          <td><span class="strong">${esc(x.name || c)}</span><div class="dim mono" style="font-size:11px">${esc(c)}</div></td>
          <td class="num">${x.price == null ? '--' : fmt(x.price)}</td>
          <td class="num ${cls(x.changePct)}">${pct(x.changePct)}</td>
          <td class="num">${x.marketCap == null ? '--' : cnAmount(x.marketCap * 1e8)}</td>
          <td class="num" style="white-space:nowrap">
            <button class="btn btn-xs btn-ghost pk-w-fin" data-code="${esc(c)}" data-name="${esc(x.name || c)}">财报</button>
            <button class="btn btn-xs btn-ghost pk-w-del" data-code="${esc(c)}">移除</button>
          </td>
        </tr>`;
      }).join('')}</tbody></table>
      <p class="dim-hint">自选股用于「财报整理 → 载入自选股」与通知订阅中的自选异动提醒。</p>`);

    $$('#pkWatchList .pk-w-del').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await API.removeWatch(b.dataset.code);
        state.portfolio.watchlist = r.list;
        toast(`已移除 ${b.dataset.code}`, 'ok');
        drawWatch();
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('#pkWatchList .pk-w-fin').forEach((b) => b.addEventListener('click', () => App.openStock(b.dataset.code, b.dataset.name)));
  }

  async function fetchQuotesSafe(codes) {
    const map = {};
    try {
      const res = await fetch(`/api/quote?codes=${encodeURIComponent(codes.join(','))}`);
      const j = await res.json();
      if (j.ok && j.data && j.data.rows) {
        j.data.rows.forEach((r) => {
          const n = UI.num(r.total_market_cap);
          map[r.code] = {
            name: r.name, price: UI.num(r.price), changePct: UI.num(r.change_percent),
            marketCap: n === null ? null : n / 1e8,
          };
        });
      }
    } catch (_) { /* 忽略：表格里显示 -- */ }
    return map;
  }

  // ---- 持仓表 ----
  function drawHoldingsTable(editCode) {
    const list = state.portfolio.holdings || [];
    const head = `<table class="dt">
      <thead><tr><th>名称 / 代码</th><th class="num">数量</th><th class="num">成本价</th><th>备注</th><th class="num">操作</th></tr></thead><tbody>`;
    const rowEdit = (h) => `<tr class="pk-edit-row">
      <td><span class="strong">${esc(h.name || h.code)}</span><div class="dim mono" style="font-size:11px">${esc(h.code)}</div></td>
      <td class="num"><input class="input input-sm" style="width:80px" id="phQty" value="${h.qty}"></td>
      <td class="num"><input class="input input-sm" style="width:80px" id="phCost" value="${h.cost}"></td>
      <td><input class="input input-sm" style="width:100%" id="phNote" value="${esc(h.note || '')}" placeholder="备注"></td>
      <td class="num" style="white-space:nowrap">
        <button class="btn btn-xs btn-primary pk-h-save" data-code="${esc(h.code)}">保存</button>
        <button class="btn btn-xs btn-ghost pk-h-cancel">取消</button>
      </td></tr>`;
    const rowView = (h) => `<tr>
      <td><span class="strong">${esc(h.name || h.code)}</span><div class="dim mono" style="font-size:11px">${esc(h.code)}</div></td>
      <td class="num">${fmtInt(h.qty)}</td>
      <td class="num">${fmt(h.cost)}</td>
      <td class="dim" style="font-size:12px">${esc(h.note || '--')}</td>
      <td class="num" style="white-space:nowrap">
        <button class="btn btn-xs btn-ghost pk-h-edit" data-code="${esc(h.code)}">编辑</button>
        <button class="btn btn-xs btn-ghost pk-h-del" data-code="${esc(h.code)}">删除</button>
      </td></tr>`;

    const addRow = `<tr class="pk-add-row">
      <td><input class="input input-sm" id="phCode" style="width:130px" placeholder="代码/名称" value="${editCode || ''}"></td>
      <td class="num"><input class="input input-sm" style="width:80px" id="phNewQty" placeholder="数量"></td>
      <td class="num"><input class="input input-sm" style="width:80px" id="phNewCost" placeholder="成本价"></td>
      <td><input class="input input-sm" style="width:100%" id="phNewNote" placeholder="备注（可选）"></td>
      <td class="num"><button class="btn btn-xs btn-primary pk-h-add">添加持仓</button></td></tr>`;

    setHtml('pkHoldingsList', `${head}
      ${addRow}
      ${list.map((h) => (h.code === editCode ? rowEdit(h) : rowView(h))).join('') || ''}
      </tbody></table>${list.length ? '' : '<p class="dim-hint">尚无持仓：可直接添加，或通过「记一笔交易（买入）」自动建立。</p>'}`);

    const saveEdit = async (btn) => {
      const code = btn.dataset.code;
      const tr = btn.closest('tr');
      try {
        await API.saveHolding({ action: 'update', code, patch: {
          qty: tr.querySelector('#phQty').value, cost: tr.querySelector('#phCost').value, note: tr.querySelector('#phNote').value,
        } });
        toast('持仓已更新', 'ok');
        state.portfolio = await API.portfolio();
        drawHoldingsTable();
      } catch (e) { toast(e.message, 'err'); }
    };
    $$('#pkHoldingsList .pk-h-save').forEach((b) => b.addEventListener('click', () => saveEdit(b)));
    $$('#pkHoldingsList .pk-h-cancel').forEach((b) => b.addEventListener('click', () => drawHoldingsTable()));
    $$('#pkHoldingsList .pk-h-edit').forEach((b) => b.addEventListener('click', () => drawHoldingsTable(b.dataset.code)));
    $$('#pkHoldingsList .pk-h-del').forEach((b) => b.addEventListener('click', async () => {
      try {
        await API.saveHolding({ action: 'remove', code: b.dataset.code });
        state.portfolio = await API.portfolio();
        toast(`已删除持仓 ${b.dataset.code}`, 'ok');
        drawHoldingsTable();
      } catch (e) { toast(e.message, 'err'); }
    }));
    $('#pkHoldingsList .pk-h-add').addEventListener('click', async () => {
      const codeRaw = $('#phCode').value.trim();
      const qty = $('#phNewQty').value;
      const cost = $('#phNewCost').value;
      if (!codeRaw) { toast('请输入代码或名称', 'err'); return; }
      try {
        const code = await resolveCode(codeRaw);
        await API.saveHolding({ code, qty, cost, note: $('#phNewNote').value });
        state.portfolio = await API.portfolio();
        toast(`已添加持仓 ${code}`, 'ok');
        drawHoldingsTable();
        drawWatch();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ---- 交易记录 ----
  function drawTx(editId) {
    const list = state.portfolio.transactions || [];
    const sideTag = (s) => tag(s === 'buy' ? '买入' : '卖出', s === 'buy' ? 'up' : 'down');
    const rowView = (t) => `<tr>
      <td class="num mono" style="font-size:12px">${esc(t.time)}</td>
      <td>${sideTag(t.side)}</td>
      <td><span class="strong">${esc(t.name || t.code)}</span><div class="dim mono" style="font-size:11px">${esc(t.code)}</div></td>
      <td class="num">${fmt(t.price)}</td>
      <td class="num">${fmtInt(t.qty)}</td>
      <td class="num">${cnAmount(t.price * t.qty)}</td>
      <td class="dim" style="font-size:12px">${esc(t.note || '--')}</td>
      <td class="num" style="white-space:nowrap">
        <button class="btn btn-xs btn-ghost pk-t-edit" data-id="${esc(t.id)}">编辑</button>
        <button class="btn btn-xs btn-ghost pk-t-del" data-id="${esc(t.id)}">删除</button>
      </td></tr>`;
    const rowEdit = (t) => `<tr class="pk-edit-row">
      <td class="num"><input class="input input-sm" style="width:130px" id="ptTime" value="${esc(t.time)}"></td>
      <td><select class="input input-sm" id="ptSide"><option value="buy" ${t.side === 'buy' ? 'selected' : ''}>买入</option><option value="sell" ${t.side === 'sell' ? 'selected' : ''}>卖出</option></select></td>
      <td><span class="strong">${esc(t.name || t.code)}</span><div class="dim mono" style="font-size:11px">${esc(t.code)}</div></td>
      <td class="num"><input class="input input-sm" style="width:80px" id="ptPrice" value="${t.price}"></td>
      <td class="num"><input class="input input-sm" style="width:80px" id="ptQty" value="${t.qty}"></td>
      <td class="num dim">${cnAmount(t.price * t.qty)}</td>
      <td><input class="input input-sm" style="width:100%" id="ptNote" value="${esc(t.note || '')}"></td>
      <td class="num" style="white-space:nowrap">
        <button class="btn btn-xs btn-primary pk-t-save" data-id="${esc(t.id)}">保存</button>
        <button class="btn btn-xs btn-ghost pk-t-cancel">取消</button>
      </td></tr>`;

    setHtml('pkTxList', `<table class="dt">
      <thead><tr><th class="num">时间</th><th>方向</th><th>标的</th><th class="num">价格</th><th class="num">数量</th><th class="num">金额</th><th>备注</th><th class="num">操作</th></tr></thead>
      <tbody>${list.map((t) => (t.id === editId ? rowEdit(t) : rowView(t))).join('') || `<tr><td colspan="8">${empty('暂无交易记录，点击右上「记一笔交易」开始记录', '🧾')}</td></tr>`}
      </tbody></table>
      <p class="dim-hint">新增交易默认同步更新持仓：买入合并数量并按加权平均成本更新；卖出扣减数量，清仓自动移除持仓。</p>`);

    $$('#pkTxList .pk-t-edit').forEach((b) => b.addEventListener('click', () => drawTx(b.dataset.id)));
    $$('#pkTxList .pk-t-cancel').forEach((b) => b.addEventListener('click', () => drawTx()));
    $$('#pkTxList .pk-t-del').forEach((b) => b.addEventListener('click', async () => {
      try {
        await API.saveTransaction({ action: 'remove', id: b.dataset.id });
        state.portfolio = await API.portfolio();
        toast('已删除交易记录（持仓不自动变动，可用「按交易重建持仓」校准）', 'ok', 3600);
        drawTx();
        drawHoldingsTable();
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('#pkTxList .pk-t-save').forEach((b) => b.addEventListener('click', async () => {
      const tr = b.closest('tr');
      try {
        await API.saveTransaction({ action: 'update', id: b.dataset.id, patch: {
          time: tr.querySelector('#ptTime').value,
          side: tr.querySelector('#ptSide').value,
          price: tr.querySelector('#ptPrice').value,
          qty: tr.querySelector('#ptQty').value,
          note: tr.querySelector('#ptNote').value,
        } });
        state.portfolio = await API.portfolio();
        toast('交易记录已更新', 'ok');
        drawTx();
      } catch (e) { toast(e.message, 'err'); }
    }));
  }

  /** 新增交易表单：以对话框式的内联卡片实现 */
  function openTxForm() {
    const wrap = document.createElement('div');
    wrap.className = 'card pk-tx-form';
    wrap.innerHTML = `
      <div class="card-head"><h2>记一笔交易</h2><button class="btn btn-icon pk-tx-close">✕</button></div>
      <div class="pk-form-grid">
        <label>标的（代码 / 名称）<input class="input" id="ptfCode" placeholder="如 sh600519 / 贵州茅台"></label>
        <label>方向<select class="input" id="ptfSide"><option value="buy">买入</option><option value="sell">卖出</option></select></label>
        <label>成交价格（元）<input class="input" id="ptfPrice" type="number" step="0.01" min="0.01"></label>
        <label>数量（股）<input class="input" id="ptfQty" type="number" step="100" min="1"></label>
        <label>成交时间<input class="input" id="ptfTime" placeholder="${new Date().toISOString().slice(0, 16)}"></label>
        <label>备注<input class="input" id="ptfNote" placeholder="可选"></label>
      </div>
      <div class="pk-form-foot">
        <label class="chk"><input type="checkbox" id="ptfApply" checked> 同步更新持仓</label>
        <button class="btn btn-sm btn-primary" id="ptfSubmit">保存交易</button>
      </div>`;
    document.getElementById('view-picker').querySelector('.view-head').insertAdjacentElement('afterend', wrap);
    wrap.querySelector('.pk-tx-close').addEventListener('click', () => wrap.remove());
    wrap.querySelector('#ptfSubmit').addEventListener('click', async () => {
      try {
        const code = await resolveCode(wrap.querySelector('#ptfCode').value.trim());
        const r = await API.saveTransaction({
          code,
          side: wrap.querySelector('#ptfSide').value,
          price: wrap.querySelector('#ptfPrice').value,
          qty: wrap.querySelector('#ptfQty').value,
          time: wrap.querySelector('#ptfTime').value,
          note: wrap.querySelector('#ptfNote').value,
          applyToHolding: wrap.querySelector('#ptfApply').checked,
        });
        toast(`已记录交易：${r.item.side === 'buy' ? '买入' : '卖出'} ${r.item.name} ${r.item.qty} 股 @ ${r.item.price}`
          + (r.applied && r.applied.applied ? '（持仓已同步）' : r.applied && r.applied.reason ? `（${r.applied.reason}）` : ''), 'ok', 3600);
        wrap.remove();
        state.portfolio = await API.portfolio();
        drawTx();
        drawHoldingsTable();
      } catch (e) { toast(e.message, 'err'); }
    });
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** 代码/名称 → 规范代码（纯代码直接通过，其余走搜索接口） */
  async function resolveCode(v) {
    if (!v) throw new Error('请输入标的');
    if (/^[a-z]{2}\d+/i.test(v)) return v;
    const s = await API.financeSearch(v);
    if (!s.list || !s.list.length) throw new Error(`未找到标的「${v}」`);
    return s.list[0].code;
  }

  // ============================================================
  // 事件
  // ============================================================
  function bindOnce() {
    $$('#pkSeg .seg-item').forEach((b) => {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    // 激进度切换：保存偏好并按档位重新拉取（每日快照按档位缓存，切换通常秒回）
    $$('#pkProfileSeg .seg-item').forEach((b) => {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        if (state.profile === b.dataset.profile) return;
        state.profile = b.dataset.profile;
        try { localStorage.setItem('fh.picker.profile', state.profile); } catch (_) { /* ignore */ }
        // 选中态（图标）必须立即跟随，再异步加载该档位数据；
        // 此前只在 render() 里同步，而本处理直接调 renderDaily() 绕过了它，导致图标不切换
        syncProfileSeg();
        renderDaily();
      });
    });
    const btn = $('#pkRerun');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '分析中…';
        try { await renderDaily({ force: true }); toast('已重新生成今日推荐', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
        finally { btn.disabled = false; btn.textContent = old; }
      });
    }
    const hr = $('#pkHRefresh');
    if (hr && !hr.dataset.bound) {
      hr.dataset.bound = '1';
      hr.addEventListener('click', () => renderHoldings({ force: true }));
    }
    const wa = $('#pkWatchAdd');
    if (wa && !wa.dataset.bound) {
      wa.dataset.bound = '1';
      wa.addEventListener('click', async () => {
        const inp = $('#pkWatchInput');
        const v = inp.value.trim();
        if (!v) return;
        try {
          const code = await resolveCode(v);
          const r = await API.addWatch(code);
          state.portfolio.watchlist = r.list;
          inp.value = '';
          toast(`已加入自选：${code}`, 'ok');
          drawWatch();
        } catch (e) { toast(e.message, 'err'); }
      });
      $('#pkWatchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pkWatchAdd').click(); });
    }
    const ha = $('#pkHoldAdd');
    if (ha && !ha.dataset.bound) {
      ha.dataset.bound = '1';
      ha.addEventListener('click', () => { const c = $('#phCode'); if (c) { c.focus(); c.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
    }
    const ta = $('#pkTxAdd');
    if (ta && !ta.dataset.bound) { ta.dataset.bound = '1'; ta.addEventListener('click', openTxForm); }
    const trb = $('#pkTxRebuild');
    if (trb && !trb.dataset.bound) {
      trb.dataset.bound = '1';
      trb.addEventListener('click', async () => {
        if (!confirm('将按全部交易记录（时间正序）回放重建持仓，手工持仓会被覆盖。继续？')) return;
        try {
          const r = await API.saveTransaction({ action: 'rebuild' });
          state.portfolio = await API.portfolio();
          toast(`已按交易记录重建持仓（${r.rebuilt} 只）`, 'ok');
          drawHoldingsTable();
        } catch (e) { toast(e.message, 'err'); }
      });
    }
  }

  function init() { bindOnce(); }

  window.ViewPicker = { render, init };
})();
