/* modules/worlddesk.js — 国际形势金融分析视图 */
(function () {
  'use strict';
  const { $, $$, fmt, fmtInt, pct, cls, setHtml, esc, empty, errorBox, toast } = UI;

  const state = { data: null };
  const TONE_META = { up: ['利多', 'up'], down: ['利空', 'down'], mixed: ['双向 / 视路径', 'warn'] };

  async function render(sub, params) {
    if (params && params.refresh) state.data = null;
    if (state.data) { draw(state.data); return; }
    setHtml('wdKpis', `<div class="kpi"><div class="loading-inline dim">正在聚合全球行情与国际要闻…</div></div>`);
    try {
      const d = await UI.task(() => API.worldDesk(14), { loadingText: '正在聚合多源要闻并生成影响分析（约 5–15 秒）…' });
      state.data = d;
      draw(d);
    } catch (e) {
      setHtml('wdKpis', errorBox(e.message));
    }
  }

  function draw(d) {
    const s = d.snapshot || {};
    const idx = s.indices || [];
    const usd = s.usdIndex || {};
    const oil = s.oil || {};
    const metals = s.metals || [];

    // ---- 全球市场快照 KPI ----
    setHtml('wdKpis', idx.slice(0, 3).map((x) => `
      <div class="kpi ${x.changePct >= 0 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">${esc(x.name)}</div>
        <div class="kpi-value">${fmt(x.price)}</div>
        <div class="kpi-foot"><span class="${cls(x.changePct)}">${pct(x.changePct)}</span> · ${esc(x.market)}</div>
      </div>`).join('') + `
      <div class="kpi ${usd.changePct >= 0 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">美元指数</div>
        <div class="kpi-value">${fmt(usd.price)}</div>
        <div class="kpi-foot"><span class="${cls(usd.changePct)}">${pct(usd.changePct)}</span> · 全球流动性锚</div>
      </div>
      <div class="kpi ${(oil.changePct || 0) >= 0 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">${esc(oil.name || '原油')}</div>
        <div class="kpi-value">${fmt(oil.price)}</div>
        <div class="kpi-foot"><span class="${cls(oil.changePct)}">${pct(oil.changePct)}</span> · 通胀与地缘温度计</div>
      </div>
      <div class="kpi ${(metals[0] && metals[0].changePct || 0) >= 0 ? 'k-up' : 'k-down'}">
        <div class="kpi-label">伦敦金现货</div>
        <div class="kpi-value">${fmt(metals[0] && metals[0].price)}</div>
        <div class="kpi-foot"><span class="${cls(metals[0] && metals[0].changePct)}">${pct(metals[0] && metals[0].changePct)}</span> · 避险情绪风向标</div>
      </div>`);

    // ---- 整体基调 ----
    const tone = d.tone || {};
    setHtml('wdToneSub', `命中 ${d.themeCount} 个主题 · 要闻 ${d.newsTotal} 条`);
    setHtml('wdTone', `
      <span class="stat-item">当前基调 <b>${esc(tone.label || '--')}</b></span>
      <span class="stat-item">避险类主题热度 <b>${fmtInt(tone.riskOffCount)}</b>（地缘 / 贸易）</span>
      <span class="stat-item">政策类主题热度 <b>${fmtInt(tone.riskOnCount)}</b>（国内政策）</span>
      <span class="stat-item dim">${esc(tone.note || '')}</span>`);

    // ---- 主题影响分析卡片 ----
    const themes = d.themes || [];
    setHtml('wdThemes', themes.length ? themes.map((t) => `
      <article class="wd-theme" style="border-left-color:var(--primary)">
        <div class="wdt-head">
          <h3>${esc(t.title)}</h3>
          <span class="tag tag-info">命中 ${t.hitCount} 条</span>
        </div>
        ${(t.headlines || []).length ? `<ul class="wdt-news">${t.headlines.map((h) => `
          <li>
            <a href="${esc(h.url || '#')}" target="_blank" rel="noopener" class="wdt-link">${esc(h.title)}</a>
            <span class="dim" style="font-size:11.5px">${esc(h.src || h.channel || '')}${h.time ? ' · ' + esc(String(h.time).slice(5, 16)) : ''}</span>
          </li>`).join('')}</ul>` : ''}
        <div class="wdt-impacts">
          ${(t.impacts || []).map((im) => {
            const [label, clsName] = TONE_META[im.tone] || [im.tone, ''];
            return `<span class="wdi"><span class="wdi-asset">${esc(im.asset)}</span>
              <span class="tag tag-${clsName === 'up' ? 'up' : clsName === 'down' ? 'down' : 'info'}">${label}</span>
              <span class="wdi-note">${esc(im.note)}</span></span>`;
          }).join('')}
        </div>
      </article>`).join('') : empty('近期要闻暂未命中已知国际主题（货币政策 / 关税贸易 / 地缘冲突 / 能源 / 央行汇率等）。可稍后刷新重试。', '🌐'));

    // ---- 要闻流 ----
    setHtml('wdNewsSub', `共 ${d.newsTotal} 条 · 按发布时间倒序`);
    setHtml('wdNews', (d.news || []).slice(0, 24).map((n) => `
      <div class="nm-item">
        <a class="nm-title" href="${esc(n.url || '#')}" target="_blank" rel="noopener">${esc(n.title)}</a>
        <div class="nm-meta"><span class="tag tag-info" style="font-size:10px;padding:1px 6px">${esc(n.channel || '')}</span> ${esc(n.src || '')}${n.time ? ' · ' + esc(String(n.time).slice(5, 16)) : ''}</div>
      </div>`).join('') || empty('暂无要闻'));

    setHtml('wdNewsSub', `共 ${d.newsTotal} 条 · ${esc(d.source || '')}`);
  }

  let bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    $('#wdRefresh').addEventListener('click', async () => {
      try {
        API.clearCache().catch(() => {});
        state.data = null;
        toast('正在刷新国际形势数据…', '', 1200);
        setTimeout(() => render(null, { refresh: true }), 200);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  window.ViewWorlddesk = { render };
})();
