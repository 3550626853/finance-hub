/* notify.js — 通知中心抽屉与订阅管理 */
(function () {
  'use strict';
  const { $, $$, esc, fmt, timeAgo, toast, setHtml, empty, task, tag } = UI;

  const state = { open: false, filter: 'all', list: [], stats: {}, subs: [], onUpdate: null };

  const ICON = { high: '⚠️', normal: '•' };

  function bell() { return $('#bellCount'); }
  function navBadge() { return $('#navBadgeIpo'); }

  function updateBadge(unread) {
    const b = bell();
    if (b) { b.hidden = !unread; b.textContent = unread > 99 ? '99+' : unread; }
    const nb = navBadge();
    if (nb) nb.textContent = unread ? String(unread) : '';
    const uc = $('#unreadCount');
    if (uc) uc.textContent = unread || 0;
  }

  async function load(showLoading) {
    const data = await (showLoading
      ? task(() => API.notifications({ limit: 200 }), { loadingText: '加载通知…' })
      : API.notifications({ limit: 200 }));
    state.list = data.list || [];
    state.stats = data.stats || {};
    updateBadge(state.stats.unread || 0);
    if (state.open) render();
    if (state.onUpdate) state.onUpdate(data);
    return data;
  }

  async function loadSubs() {
    const d = await API.subscriptions();
    state.subs = d.list || [];
    return state.subs;
  }

  // ---------- 渲染 ----------
  function render() {
    const body = $('#drawerBody');
    if (!body) return;

    if (state.filter === 'subs') return renderSubs(body);

    let list = state.list;
    if (state.filter === 'unread') list = list.filter((x) => !x.read);

    if (!list.length) {
      body.innerHTML = empty(state.filter === 'unread' ? '没有未读消息' : '暂无通知，点击下方「立即巡检」获取最新动态', '🔔');
      return;
    }

    body.innerHTML = list.map((n) => {
      const lv = n.level === 'high' ? 'lv-high' : '';
      const unread = !n.read ? 'unread' : '';
      return `<div class="ntf ${unread} ${lv}" data-id="${esc(n.id)}">
        <div class="ntf-head">
          ${!n.read ? '<span class="ntf-unread-dot"></span>' : ''}
          ${tag(n.category || '通知', n.level === 'high' ? 'hot' : 'primary')}
          ${n.level === 'high' ? tag('重要', 'warn') : ''}
        </div>
        <div class="ntf-title">${esc(n.title)}</div>
        ${n.body ? `<div class="ntf-body">${esc(n.body)}</div>` : ''}
        <div class="ntf-time"><span>${esc(n.source || '系统巡检')}</span><span>${timeAgo(n.createdAt)}</span></div>
      </div>`;
    }).join('');

    $$('.ntf', body).forEach((el) => {
      el.addEventListener('click', async () => {
        const id = el.dataset.id;
        el.classList.remove('unread');
        await API.markRead([id]);
        const item = state.list.find((x) => x.id === id);
        if (item) item.read = true;
        state.stats.unread = Math.max(0, (state.stats.unread || 1) - 1);
        updateBadge(state.stats.unread);
        render();
      });
    });
  }

  function renderSubs(body) {
    if (!state.subs.length) { body.innerHTML = empty('暂无订阅规则'); return; }
    const DESC = {
      ipo: '沪深新股发行/申购动态实时追踪',
      ipo_calendar: '新股申购开始与上市日提前提醒',
      financial_report: '持仓及自选股财报预约披露日提醒',
      index_move: '主要指数单日波动超过阈值时预警',
      watchlist_move: '自选股单日涨跌幅超过阈值时预警',
    };
    body.innerHTML = `<p style="font-size:12.5px;color:var(--muted);margin:0 0 12px">
        订阅开启后，平台每 10 分钟自动巡检一次，命中规则即推送到本通知中心。</p>`
      + state.subs.map((s) => `
      <div class="sub-row">
        <div class="sub-info">
          <div class="sub-name">${esc(s.label)}</div>
          <div class="sub-desc">${esc(DESC[s.type] || '')}${
            (s.type === 'index_move' || s.type === 'watchlist_move')
              ? ` · 阈值 <input class="input input-sm" data-thr="${esc(s.id)}" type="number" step="0.5" min="0.5"
                   value="${s.threshold || ''}" style="width:64px;padding:2px 6px;display:inline-block">%`
              : ''}</div>
        </div>
        <div class="switch ${s.enabled ? 'on' : ''}" data-sub="${esc(s.id)}"></div>
      </div>`).join('');

    $$('.switch', body).forEach((sw) => {
      sw.addEventListener('click', async () => {
        const id = sw.dataset.sub;
        const next = !sw.classList.contains('on');
        sw.classList.toggle('on', next);
        try {
          await API.toggleSubscription(id, next);
          const s = state.subs.find((x) => x.id === id);
          if (s) s.enabled = next;
          toast(next ? '已开启订阅' : '已关闭订阅', 'ok', 1500);
        } catch (e) {
          sw.classList.toggle('on', !next);
          toast(e.message, 'err');
        }
      });
    });

    $$('input[data-thr]', body).forEach((inp) => {
      inp.addEventListener('change', async () => {
        const id = inp.dataset.thr;
        const v = Number(inp.value);
        if (!Number.isFinite(v) || v <= 0) return;
        try {
          await API.updateSubscription(id, { threshold: v });
          const s = state.subs.find((x) => x.id === id);
          if (s) s.threshold = v;
          toast(`阈值已更新为 ${v}%`, 'ok', 1500);
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  }

  // ---------- 开关抽屉 ----------
  async function open(filter) {
    state.open = true;
    if (filter) state.filter = filter;
    $('#drawer').classList.add('open');
    $('#drawerMask').hidden = false;
    $$('.dtab').forEach((t) => t.classList.toggle('active', t.dataset.filter === state.filter));
    try {
      await load(true);
      await loadSubs();
      render();
    } catch (e) { $('#drawerBody').innerHTML = UI.errorBox(e.message); }
  }

  function close() {
    state.open = false;
    $('#drawer').classList.remove('open');
    $('#drawerMask').hidden = true;
  }

  // ---------- 初始化 ----------
  function init(onUpdate) {
    state.onUpdate = onUpdate;
    $('#btnBell').addEventListener('click', () => (state.open ? close() : open()));
    $('#drawerClose').addEventListener('click', close);
    $('#drawerMask').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) close(); });

    $$('.dtab').forEach((t) => t.addEventListener('click', async () => {
      state.filter = t.dataset.filter;
      $$('.dtab').forEach((x) => x.classList.toggle('active', x === t));
      if (state.filter === 'subs' && !state.subs.length) await loadSubs();
      render();
    }));

    $('#btnMarkAll').addEventListener('click', async () => {
      try {
        await API.markRead([]);
        state.list.forEach((x) => { x.read = true; });
        state.stats.unread = 0;
        updateBadge(0); render();
        toast('已全部标记为已读', 'ok', 1600);
      } catch (e) { toast(e.message, 'err'); }
    });

    $('#btnClearRead').addEventListener('click', async () => {
      try {
        const r = await API.clearNotifications(true);
        toast(`已清除 ${r.removed} 条已读通知`, 'ok', 1800);
        await load(); render();
      } catch (e) { toast(e.message, 'err'); }
    });

    $('#btnScanNow').addEventListener('click', async () => {
      try {
        const r = await task(() => API.scanNow(), { loadingText: '正在巡检市场动态…' });
        await load();
        render();
        toast(r.created ? `巡检完成，新增 ${r.created} 条提醒` : '巡检完成，暂无新动态', 'ok', 2200);
      } catch (e) { toast(e.message, 'err'); }
    });

    // 首屏静默拉取未读数
    load().catch(() => {});
    // 每 2 分钟刷新未读角标
    setInterval(() => load().catch(() => {}), 120000);
  }

  window.Notify = { init, load, open, close, updateBadge, get stats() { return state.stats; } };
})();
