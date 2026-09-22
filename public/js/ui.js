/* ui.js — 共享 UI 工具：格式化、图表、表格、提示 */
(function () {
  'use strict';

  const C = {
    up: '#d92b2b', down: '#0f9d58', flat: '#8b95a8',
    primary: '#2563eb', ink: '#1b2333', muted: '#8b95a8',
    border: '#e4e8f0', grid: '#eef1f7',
    palette: ['#2563eb', '#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#6366f1', '#14b8a6'],
  };

  // ---------- 格式化 ----------
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  function fmt(v, d = 2) {
    const n = num(v);
    if (n === null) return '--';
    return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtInt(v) { const n = num(v); return n === null ? '--' : Math.round(n).toLocaleString('zh-CN'); }

  function pct(v, d = 2, withSign = true) {
    const n = num(v);
    if (n === null) return '--';
    return `${withSign && n > 0 ? '+' : ''}${n.toFixed(d)}%`;
  }

  function cls(v) { const n = num(v); return n === null ? 'flat' : n > 0 ? 'up' : n < 0 ? 'down' : 'flat'; }

  function cnAmount(v, d = 2) {
    const n = num(v);
    if (n === null) return '--';
    const a = Math.abs(n);
    if (a >= 1e12) return `${(n / 1e12).toFixed(d)}万亿`;
    if (a >= 1e8) return `${(n / 1e8).toFixed(d)}亿`;
    if (a >= 1e4) return `${(n / 1e4).toFixed(d)}万`;
    return n.toFixed(d);
  }

  function timeAgo(iso) {
    if (!iso) return '--';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '--';
    const diff = Date.now() - t;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
    if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
    return new Date(t).toLocaleDateString('zh-CN');
  }

  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 图表 ----------
  const charts = new Map();

  function destroyChart(id) {
    const c = charts.get(id);
    if (c) { try { c.destroy(); } catch (_) {} charts.delete(id); }
  }

  const baseOpts = () => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#4a5568', font: { size: 11 }, boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 12 } },
      tooltip: {
        backgroundColor: 'rgba(27,35,51,.94)', titleColor: '#fff', bodyColor: '#e5e7eb',
        padding: 10, cornerRadius: 7, titleFont: { size: 12 }, bodyFont: { size: 12 }, displayColors: true, boxPadding: 4,
      },
    },
    scales: {
      x: { ticks: { color: '#8b95a8', font: { size: 11 } }, grid: { color: C.grid, drawTicks: false }, border: { color: C.border } },
      y: { ticks: { color: '#8b95a8', font: { size: 11 } }, grid: { color: C.grid, drawTicks: false }, border: { color: C.border } },
    },
  });

  /**
   * 图表工厂。
   * 注意：Chart.js 的 config.plugins 是「插件数组」槽位，绝不能放插件选项对象，
   * 否则会污染内部 _plugins 导致数据集绘制链路失效。所有样式一律走 options。
   */
  function chart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    destroyChart(id);

    const base = baseOpts();
    const incoming = config.options || {};
    const isRadar = config.type === 'radar';
    const incPlugins = incoming.plugins || {};
    const options = {
      ...base,
      ...incoming,
      plugins: {
        ...base.plugins,
        ...incPlugins,
        // legend / tooltip 做一层深合并，保留基础样式的同时允许局部覆盖（如 display:false）
        legend: { ...base.plugins.legend, ...(incPlugins.legend || {}) },
        tooltip: { ...base.plugins.tooltip, ...(incPlugins.tooltip || {}) },
      },
      // 直角坐标系图表：把调用方传入的轴配置「合并」到基础轴样式上，保留默认网格/刻度风格
      // 雷达图无 x/y 轴，直接用调用方配置，避免注入多余轴导致异常
      scales: isRadar
        ? incoming.scales
        : { ...base.scales, ...(incoming.scales || {}) },
    };

    const cfg = { type: config.type, data: config.data, options };
    const inst = new Chart(canvas.getContext('2d'), cfg);
    charts.set(id, inst);
    // 容器尺寸可能在图表创建后才稳定（如标签页切换、字体加载），补一次重算
    const nudge = () => { try { inst.resize(); } catch (_) { /* ignore */ } };
    requestAnimationFrame(nudge);
    setTimeout(nudge, 160);
    return inst;
  }

  function lineChart(id, labels, datasets, opts = {}) {
    return chart(id, { type: 'line', data: { labels, datasets }, options: opts });
  }

  function barChart(id, labels, datasets, opts = {}) {
    return chart(id, { type: 'bar', data: { labels, datasets }, options: opts });
  }

  function radarChart(id, labels, datasets, opts = {}) {
    const { max = 5, step = 1, ...rest } = opts;
    return chart(id, {
      type: 'radar',
      data: { labels, datasets },
      options: {
        ...rest,
        scales: {
          r: {
            beginAtZero: true, min: 0, max,
            ticks: { stepSize: step, color: '#b6bfd0', font: { size: 10 }, backdropColor: 'transparent' },
            grid: { color: C.grid }, angleLines: { color: C.grid },
            pointLabels: { color: '#4a5568', font: { size: 11 } },
          },
        },
      },
    });
  }

  /** 迷你走势图（无坐标轴） */
  function sparkline(canvas, values, color) {
    const vals = values.filter((v) => num(v) !== null).map(Number);
    if (vals.length < 2) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 260, h = canvas.clientHeight || 42;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const c = color || (vals[vals.length - 1] >= vals[0] ? C.up : C.down);
    const X = (i) => (i / (vals.length - 1)) * (w - 2) + 1;
    const Y = (v) => h - 3 - ((v - mn) / rng) * (h - 8);

    ctx.clearRect(0, 0, w, h);
    // 面积
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, c + '33'); grad.addColorStop(1, c + '00');
    ctx.beginPath(); ctx.moveTo(X(0), h);
    vals.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
    ctx.lineTo(X(vals.length - 1), h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    // 线
    ctx.beginPath();
    vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  }

  // ---------- DOM ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }

  function empty(msg, ico) {
    return `<div class="empty"><span class="empty-ico">${ico || '∅'}</span>${esc(msg)}</div>`;
  }

  function errorBox(msg) {
    return `<div class="err-box">⚠️ ${esc(msg)}</div>`;
  }

  function skeleton(rows = 4) {
    return Array.from({ length: rows }, (_, i) =>
      `<div class="skeleton" style="width:${70 + (i % 3) * 10}%"></div>`).join('');
  }

  // ---------- 提示 ----------
  function toast(msg, type = '', ms = 2600) {
    const wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 320);
    }, ms);
  }

  let loadingCount = 0;
  function loading(on, text) {
    const mask = document.getElementById('loadingMask');
    const t = document.getElementById('loadingText');
    if (!mask) return;
    if (on) {
      loadingCount++;
      if (t && text) t.textContent = text;
      mask.hidden = false;
    } else {
      loadingCount = Math.max(0, loadingCount - 1);
      if (loadingCount === 0) mask.hidden = true;
    }
  }

  /** 包装异步任务：统一 loading / 错误提示 */
  async function task(fn, { loadingText, silent = false } = {}) {
    if (!silent) loading(true, loadingText);
    try {
      return await fn();
    } catch (e) {
      console.error(e);
      if (!silent) toast(e.message || '操作失败', 'err');
      throw e;
    } finally {
      if (!silent) loading(false);
    }
  }

  // ---------- 表格构建 ----------
  /** columns: [{key,label,align,render(row)}] */
  function buildTable(columns, rows, opts = {}) {
    if (!rows || !rows.length) return empty(opts.emptyText || '暂无数据');
    const th = columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${esc(c.label)}</th>`).join('');
    const body = rows.map((r) => {
      const tds = columns.map((c) => {
        const v = c.render ? c.render(r) : esc(r[c.key]);
        return `<td class="${c.align === 'right' ? 'num' : ''}">${v === undefined || v === null ? '--' : v}</td>`;
      }).join('');
      const clsRow = opts.rowClass ? ` class="${opts.rowClass(r)}"` : '';
      const attr = opts.onRow ? ` data-idx="${rows.indexOf(r)}"` : '';
      return `<tr${clsRow}${attr}>${tds}</tr>`;
    }).join('');
    return `<table class="dt ${opts.tableClass || ''}"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
  }

  /** 绑定表格行点击（配合 buildTable 的 onRow） */
  function bindRows(containerId, rows, handler) {
    const el = document.getElementById(containerId);
    if (!el) return;
    $$('tbody tr', el).forEach((tr) => {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => handler(rows[Number(tr.dataset.idx)]));
    });
  }

  const tag = (text, tone) => `<span class="tag tag-${tone || 'muted'}">${esc(text)}</span>`;

  const scoreColor = (s) => {
    const n = num(s);
    if (n === null) return C.muted;
    return n >= 7 ? C.up : n >= 5.6 ? '#f97316' : n >= 4.4 ? '#eab308' : C.down;
  };

  window.UI = {
    C, num, fmt, fmtInt, pct, cls, cnAmount, timeAgo, esc, tag, scoreColor,
    chart, lineChart, barChart, radarChart, sparkline, destroyChart,
    $, $$, setHtml, empty, errorBox, skeleton, toast, loading, task, buildTable, bindRows,
  };
})();
