'use strict';
/**
 * server.js — 金融信息聚合平台 · 本地服务
 * 零外部依赖（Node 原生 http）。启动： node server.js  [--port 8787]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { Store } = require('./lib/store');
const S = require('./lib/service');
const W = require('./lib/westock');
const CATALOG = require('./lib/catalog');
const RECOMMEND = require('./lib/recommend');
const GM = require('./lib/global-markets');
const WORLD = require('./lib/worlddesk');
const TERMS = require('./lib/terms');
const P = require('./lib/picker');
const { APPENDIX } = require('./lib/appendix');

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORT_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

const store = new Store();
const START_AT = new Date();

/** 交易 → 持仓联动：买入按加权平均成本合并；卖出扣减数量（清仓自动移除） */
function applyTransactionToHolding(st, tx) {
  if (!tx || !tx.code) return { applied: false };
  const h = st.holdings.find((x) => x.code === tx.code);
  if (tx.side === 'buy') {
    if (h) {
      const newQty = h.qty + tx.qty;
      const newCost = newQty > 0 ? (h.qty * h.cost + tx.qty * tx.price) / newQty : tx.price;
      st.upsertHolding({ code: tx.code, name: tx.name || h.name, qty: newQty, cost: Math.round(newCost * 1000) / 1000 });
    } else {
      st.upsertHolding({ code: tx.code, name: tx.name, qty: tx.qty, cost: tx.price });
    }
    return { applied: true };
  }
  // 卖出：无持仓时仅保存交易，不凭空造出负持仓
  if (!h) return { applied: false, reason: '无对应持仓，仅保存交易记录' };
  const newQty = h.qty - tx.qty;
  if (newQty <= 0) { st.removeHolding(tx.code); return { applied: true, cleared: true }; }
  st.upsertHolding({ code: tx.code, qty: newQty });   // 平均成本口径不变
  return { applied: true };
}

/** 按交易记录（时间正序回放）整体重建持仓——用于手动修正，会覆盖手工持仓 */
function rebuildHoldingsFromTransactions(st) {
  const byCode = new Map();
  const txs = [...st.transactions].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  txs.forEach((t) => {
    const cur = byCode.get(t.code) || { code: t.code, name: t.name || t.code, qty: 0, cost: 0 };
    if (t.side === 'buy') {
      const newQty = cur.qty + t.qty;
      cur.cost = newQty > 0 ? (cur.qty * cur.cost + t.qty * t.price) / newQty : t.price;
      cur.qty = newQty;
    } else {
      cur.qty = Math.max(0, cur.qty - t.qty);
    }
    byCode.set(t.code, cur);
  });
  [...st.holdings].forEach((h) => st.removeHolding(h.code));
  [...byCode.values()].filter((h) => h.qty > 0).forEach((h) => st.upsertHolding(h));
  return st.holdings;
}

/** 每日自动选股：北京时间每天 08:30 后首次巡检时运行；当日已生成则直接命中缓存（三档激进度各生成一份） */
let pickDayDone = null;
async function dailyPickJob(reason) {
  for (const key of P.PROFILE_ORDER) {
    try {
      const r = await P.runDailyPick(store, { profile: key });
      console.log(`[picker:${key}] ${reason}：${r.date} 推荐 ${r.count} 只（${r.tier}口径）`);
    } catch (e) { console.error(`[picker:${key}] 运行失败:`, e.message); }
  }
}
function scheduleDailyPick() {
  const bj = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const tick = async () => {
    const iso = bj();
    const day = iso.slice(0, 10);
    if (pickDayDone !== day && iso.slice(11, 16) >= '08:30') {
      pickDayDone = day;
      await dailyPickJob('每日定时分析');
    }
  };
  setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000);
  // 启动后 15 秒补跑：当日已有结果则直接返回缓存，不会重复计算
  setTimeout(() => { tick().catch(() => {}); }, 15000);
}

// ---------- 工具 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 0);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
    });
  });
}

/** 'a,b, c' → ['a','b','c']（去空、去重） */
function splitCodes(raw) {
  return [...new Set(String(raw || '').split(',').map((x) => x.trim()).filter(Boolean))];
}

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // 本地开发/使用场景：始终校验最新文件，避免改了代码却看到旧页面
      'Cache-Control': 'no-cache, must-revalidate',
    });
    res.end(buf);
  });
}

// ---------- API 路由 ----------

const routes = [
  ['GET', /^\/api\/health$/, async () => ({
    ok: true, service: 'finance-hub', startedAt: START_AT.toISOString(), uptimeSec: Math.round((Date.now() - START_AT) / 1000),
    westockBin: W.WESTOCK_BIN, westockAvailable: fs.existsSync(W.WESTOCK_BIN),
    store: store.stats(),
  })],

  // ---- 总览 ----
  ['GET', /^\/api\/overview$/, async () => {
    const [idx, breadth, profile, ipo] = await Promise.all([
      S.indexOverview().catch((e) => ({ list: [], error: e.message })),
      S.marketBreadth().catch((e) => ({ error: e.message })),
      S.marketProfile().catch((e) => ({ error: e.message, dims: [] })),
      S.ipoModule('hs').catch((e) => ({ list: [], total: 0, error: e.message, stats: {} })),
    ]);
    return {
      updatedAt: new Date().toISOString(),
      indices: idx.list,
      breadth,
      profile: { adjScore: profile.adjScore, rawScore: profile.rawScore, dataDate: profile.dataDate, scoreAvg: profile.scoreAvg, strongest: profile.strongest, weakest: profile.weakest },
      ipo: { total: ipo.total, stats: ipo.stats, list: (ipo.list || []).slice(0, 8) },
      notifications: store.stats(),
      watchlist: store.watchlist,
    };
  }],

  // ---- 模块一：新股消息 ----
  ['GET', /^\/api\/ipo$/, async (m, q) => S.ipoModule(q.market || 'hs')],
  ['GET', /^\/api\/ipo\/all$/, async () => S.ipoAllMarkets(['hs', 'hk', 'us'])],
  ['GET', /^\/api\/ipo\/calendar$/, async (m, q) => {
    const res = await W.calendar('ipo', q.market || 'hs', Number(q.limit) || 30);
    return {
      market: q.market || 'hs', updatedAt: res.fetchedAt, title: (res.tables[0] || {}).title || '新股发行',
      list: (res.rows || []).map((r) => ({
        date: r.date, code: r.symbol, name: r.stockName || r.name, price: W.toNum(r.price),
        daysLeft: S.daysBetween(new Date().toISOString().slice(0, 10), r.date),
      })),
    };
  }],

  // ---- 模块四：新股资讯 ----
  ['GET', /^\/api\/ipo\/news\/stock$/, async (m, q) => S.stockNews(q.code || '', {
    limit: Math.min(Number(q.limit) || 40, 80), detailTop: Math.min(Number(q.detail) || 24, 40),
  })],
  ['GET', /^\/api\/ipo\/news$/, async (m, q) => S.ipoNewsModule({
    market: q.market || 'all', limit: Number(q.limit) || 30, detailTop: Number(q.detail) || 14,
  })],
  // 单只新股的上市表现（暴涨 / 破发）判定，供调试与个股视图按需查询
  ['GET', /^\/api\/ipo\/perf$/, async (m, q) => {
    if (!q.code) return { ok: false, error: '缺少 code 参数' };
    const code = S.normalizeNewsCode(q.code);
    const t = { code, codeFull: code, name: q.name || null, inIpoCalendar: false };
    if (q.listingDate) {
      const issue = W.toNum(q.price);
      Object.assign(t, {
        listingDate: q.listingDate, priceMid: issue, priceLow: issue, priceHigh: issue,
        priceText: q.price || null, inIpoCalendar: true,
      });
    } else {
      // 未显式指定发行信息时，回落到新股日历匹配（命中缓存）
      const map = await S.ipoAllMarkets(['hs', 'hk']).catch(() => ({}));
      Object.values(map).forEach((mod) => (mod.list || []).forEach((x) => {
        if (t.inIpoCalendar) return;
        if (String(x.codeFull) === code || String(x.code) === code) {
          Object.assign(t, {
            name: t.name || x.name, market: x.market, listingDate: x.listingDate,
            priceMid: x.priceMid, priceLow: x.priceLow, priceHigh: x.priceHigh,
            priceText: x.priceText, inIpoCalendar: true,
          });
        }
      }));
    }
    return S.analyzeIpoPerformance(t);
  }],

  // ---- 模块五：股票列表（分类） ----
  ['GET', /^\/api\/stocks\/catalog$/, async () => CATALOG.stockCatalog()],
  ['GET', /^\/api\/stocks\/list$/, async (m, q) => CATALOG.stockListByCategory({
    kind: q.kind || 'industry', code: q.code || '', q: q.q || '',
    sort: q.sort || 'changePct', order: q.order || 'desc',
    limit: Math.min(Number(q.limit) || 60, 200), offset: Number(q.offset) || 0,
  })],

  // ---- 模块六：推荐榜单 ----
  ['GET', /^\/api\/recommend\/boards$/, async () => RECOMMEND.boardCatalog()],
  ['GET', /^\/api\/recommend\/([A-Za-z0-9_-]+)$/, async (m, q, caps) => RECOMMEND.recommendBoard(caps[1], {
    limit: Math.max(1, Math.min(Number(q.limit) || RECOMMEND.SHOW_LIMIT, 60)),
  })],

  // ---- 模块七：全球行情（贵金属 + 外汇 + 全球指数）----
  ['GET', /^\/api\/metals$/, async () => GM.metalsBoard()],
  ['GET', /^\/api\/metals\/([a-z]+)\/trend$/, async (m, q, caps) => GM.metalTrend(caps[1], Math.min(Number(q.limit) || 90, 250))],
  ['GET', /^\/api\/fx$/, async (m, q) => GM.forexBoard({ codes: q.codes ? String(q.codes).split(',').filter(Boolean) : null })],
  ['GET', /^\/api\/fx\/([A-Za-z]+)\/trend$/, async (m, q, caps) => GM.forexTrend(caps[1], Math.min(Number(q.limit) || 90, 250))],
  ['GET', /^\/api\/global\/indices$/, async () => GM.globalIndices()],

  // ---- 模块八：国际形势金融分析 ----
  ['GET', /^\/api\/world$/, async (m, q) => WORLD.worldDesk({ newsLimit: Math.min(Number(q.newsLimit) || 12, 20) })],

  // ---- 附录：术语解释 + 评分依据 ----
  ['GET', /^\/api\/appendix$/, async () => APPENDIX],
  // ---- 统一术语索引（全站术语跳转的单一数据源）----
  ['GET', /^\/api\/terms$/, async () => TERMS.buildTermIndex()],

  // ---- 模块二：财报整理 ----
  ['GET', /^\/api\/finance\/search$/, async (m, q) => {
    if (!q.q) return { list: [] };
    const res = await W.search(q.q, q.type || 'stock');
    return {
      updatedAt: res.fetchedAt, query: q.q,
      list: (res.rows || []).map((r) => ({
        code: r.code, name: r.name, market: r.market_name || r.market,
        price: W.toNum(r.price), changePct: W.toNum(r.change_percent), raw: r,
      })),
    };
  }],
  ['GET', /^\/api\/finance\/compare$/, async (m, q) => S.compareFinance((q.codes || '').split(',').map((x) => x.trim()).filter(Boolean), { periods: Number(q.periods) || 8 })],
  ['GET', /^\/api\/finance\/calendar$/, async (m, q) => S.reportCalendar(q.market || 'hs', Number(q.limit) || 40)],
  ['GET', /^\/api\/finance\/([A-Za-z0-9._-]+)\/business$/, async (m, q, caps) => S.companyBusiness(caps[1])],
  ['GET', /^\/api\/finance\/([A-Za-z0-9._-]+)$/, async (m, q, caps) => S.companyFinance(caps[1], { periods: Number(q.periods) || 12, fields: q.fields || 'all' })],

  // ---- 模块三：市场分析 ----
  ['GET', /^\/api\/market\/indices$/, async () => S.indexOverview()],
  ['GET', /^\/api\/market\/breadth$/, async () => S.marketBreadth()],
  ['GET', /^\/api\/market\/profile$/, async () => S.marketProfile()],
  ['GET', /^\/api\/market\/sectors$/, async (m, q) => S.sectorBoard({
    kind: q.kind || 'industry', type: q.type || 'changePct', order: q.order || 'desc', limit: Number(q.limit) || 20,
  })],
  ['GET', /^\/api\/market\/hot$/, async () => S.hotBoard()],
  // 批量行情（AI 选股自选表等使用；返回原始行，前端负责单位换算）
  ['GET', /^\/api\/quote$/, async (m, q) => {
    const res = await W.quote(splitCodes(q.codes));
    return { updatedAt: res.fetchedAt, rows: res.rows || [] };
  }],
  // 资金流向 / 技术扫描：按需传 codes（自选股界面已下线，不再隐式取自选股）
  ['GET', /^\/api\/market\/flow$/, async (m, q) => S.fundFlowBoard(splitCodes(q.codes))],
  ['GET', /^\/api\/market\/technical$/, async (m, q) => S.technicalScan(splitCodes(q.codes), { limit: Number(q.limit) || 60 })],
  ['GET', /^\/api\/market\/report$/, async () => S.buildMarketReport()],
  ['POST', /^\/api\/market\/report\/export$/, async (m, body, caps, req, res) => {
    const report = await S.buildMarketReport();
    const file = writeReportHtml(report, body && body.sections);
    return { ok: true, file, url: `/reports/${path.basename(file)}`, sizeKB: Math.round(fs.statSync(file).size / 1024) };
  }],
  // 市场要闻：fresh=1 强制回源（保证时效），detail 控制提取摘要的条数
  ['GET', /^\/api\/market\/news$/, async (m, q) => S.marketNews({
    limit: Math.min(50, Number(q.limit) || 40),
    detailTop: Number(q.detail) === 0 ? 0 : (Number(q.detail) || 10),
    bypass: q.fresh === '1',
  })],
  ['POST', /^\/api\/market\/news\/refresh$/, async () => {
    W.cacheClear('hot:news');
    return S.marketNews({ limit: 40, detailTop: 10, bypass: true });
  }],

  // ---- 通知中心 ----
  ['GET', /^\/api\/notifications$/, async (m, q) => {
    let list = store.notifications;
    if (q.type && q.type !== 'all') list = list.filter((x) => x.type === q.type);
    if (q.unread === '1') list = list.filter((x) => !x.read);
    return { updatedAt: new Date().toISOString(), stats: store.stats(), total: list.length, list: list.slice(0, Number(q.limit) || 200) };
  }],
  ['POST', /^\/api\/notifications\/read$/, async (m, body) => ({ ok: true, changed: store.markRead(body.ids && body.ids.length ? body.ids : ['*']) })],
  ['POST', /^\/api\/notifications\/clear$/, async (m, body) => ({ ok: true, removed: store.clearNotifications(!!(body && body.onlyRead)) })],
  ['POST', /^\/api\/notifications\/scan$/, async () => {
    const r = await S.scanNotifications(store);
    return { ok: true, ...r, stats: store.stats() };
  }],

  // ---- 订阅与自选 ----
  ['GET', /^\/api\/subscriptions$/, async () => ({ list: store.subscriptions })],
  ['POST', /^\/api\/subscriptions\/toggle$/, async (m, body) => {
    const s = store.toggleSubscription(body.id, body.enabled);
    return s ? { ok: true, item: s } : { ok: false, error: '未找到该订阅' };
  }],
  ['POST', /^\/api\/subscriptions\/update$/, async (m, body) => {
    const s = store.updateSubscription(body.id, body.patch || {});
    return s ? { ok: true, item: s } : { ok: false, error: '未找到该订阅' };
  }],
  ['POST', /^\/api\/subscriptions\/add$/, async (m, body) => ({ ok: true, item: store.addSubscription(body) })],
  ['POST', /^\/api\/subscriptions\/remove$/, async (m, body) => ({ ok: true, removed: store.removeSubscription(body.id) })],
  ['GET', /^\/api\/watchlist$/, async () => ({ list: store.watchlist })],
  ['POST', /^\/api\/watchlist$/, async (m, body) => {
    const list = body.action === 'remove' ? store.removeWatch(body.code) : (body.list ? store.setWatchlist(body.list) : store.addWatch(body.code));
    return { ok: true, list };
  }],

  // ---- AI 选股指南（按激进度档案差异化：conservative / balanced / aggressive）----
  ['GET', /^\/api\/picker\/profiles$/, async () => ({
    default: 'balanced',
    list: P.PROFILE_ORDER.map((k) => {
      const p = P.PROFILES[k];
      return { key: p.key, label: p.label, tagline: p.tagline, desc: p.desc, accent: p.accent, weights: p.weights, targetMax: p.targetMax, positionHint: p.positionHint, riskFocus: p.riskFocus };
    }),
  })],
  ['GET', /^\/api\/picker\/daily$/, async (m, q) => P.runDailyPick(store, { profile: q.profile || 'balanced' })],
  ['POST', /^\/api\/picker\/daily\/run$/, async (m, body) => P.runDailyPick(store, { force: true, profile: (body && body.profile) || 'balanced' })],
  ['GET', /^\/api\/picker\/holdings$/, async () => P.analyzeHoldings(store)],
  // 持仓 CRUD：action = add | update | remove
  ['POST', /^\/api\/portfolio\/holdings$/, async (m, body) => {
    if (body.action === 'remove') return { ok: true, removed: store.removeHolding(String(body.code || '').trim()) };
    if (body.action === 'update') {
      const h = (store.holdings || []).find((x) => x.code === String(body.code || '').trim());
      if (!h) return { ok: false, error: '未找到该持仓' };
      return { ok: true, item: store.upsertHolding({ code: body.code, ...body.patch }) };
    }
    const item = store.upsertHolding(body);
    return { ok: true, item, list: store.holdings };
  }],
  // 交易记录 CRUD：action = add | update | remove | rebuild；add 默认同步更新持仓
  ['POST', /^\/api\/portfolio\/transactions$/, async (m, body) => {
    if (body.action === 'rebuild') {
      const list = rebuildHoldingsFromTransactions(store);
      return { ok: true, holdings: list, rebuilt: list.length };
    }
    if (body.action === 'remove') {
      return { ok: true, removed: store.removeTransaction(body.id) };
    }
    if (body.action === 'update') {
      const t = store.updateTransaction(body.id, body.patch || {});
      return t ? { ok: true, item: t } : { ok: false, error: '未找到该交易记录' };
    }
    const tx = store.addTransaction(body);
    const applied = body.applyToHolding === false ? { applied: false } : applyTransactionToHolding(store, tx);
    return { ok: true, item: tx, applied, holdings: store.holdings };
  }],
  ['GET', /^\/api\/portfolio$/, async () => ({
    holdings: store.holdings,
    transactions: store.transactions,
    watchlist: store.watchlist,
  })],

  // ---- 系统 ----
  ['GET', /^\/api\/state$/, async () => ({ ok: true, store: store.stats(), subscriptions: store.subscriptions, watchlist: store.watchlist, server: { startedAt: START_AT.toISOString(), port: PORT } })],
  ['POST', /^\/api\/cache\/clear$/, async () => ({ ok: true, cleared: W.cacheClear() })],
];

// ---------- 报告 HTML 导出 ----------

function esc(s) { return String(s === null || s === undefined ? '--' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '--' : Number(v).toFixed(d));

function writeReportHtml(r, sections) {
  const pct = (v) => (v === null || v === undefined ? '--' : `${v >= 0 ? '+' : ''}${fmt(v, 2)}%`);
  const cls = (v) => (v === null || v === undefined ? '' : v >= 0 ? 'up' : 'down');

  const idxRows = (r.indices || []).map((x) => `<tr><td>${esc(x.name)}</td><td class="num ${cls(x.changePct)}">${fmt(x.price)}</td><td class="num ${cls(x.changePct)}">${pct(x.changePct)}</td><td class="num">${S.fmtCnAmount(x.amount)}</td><td class="num ${cls(x.chg5d)}">${pct(x.chg5d)}</td><td class="num ${cls(x.chg20d)}">${pct(x.chg20d)}</td><td class="num ${cls(x.chgYtd)}">${pct(x.chgYtd)}</td></tr>`).join('');
  const dimRows = ((r.profile && r.profile.dims) || []).map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${d.score === null ? '--' : d.score + ' / 5'}</td><td>${esc(d.status)}</td></tr>`).join('');
  const secRows = (arr, flow) => (arr || []).map((s, i) => `<tr><td class="num">${i + 1}</td><td>${esc(s.name)}</td><td class="num ${cls(s.changePct)}">${pct(s.changePct)}</td><td class="num ${cls(s.mainNetInflow)}">${s.mainNetInflow === null ? '--' : S.fmtCnAmount(s.mainNetInflow)}</td></tr>`).join('');
  const bins = ((r.breadth && r.breadth.bins) || []).map((b) => `<tr><td>${esc(b.bin)}</td><td class="num">${b.count}</td><td>${esc(b.dir)}</td></tr>`).join('');
  const li = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join('');

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>A股市场分析报告 · ${esc(r.dataDate)}</title>
<style>
:root{--up:#d92b2b;--down:#12a150;--ink:#1f2937;--mut:#6b7280;--line:#e5e7eb;--bg:#f7f8fa}
*{box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:32px 20px;line-height:1.65}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:26px;margin:0 0 6px}.meta{color:var(--mut);font-size:13px;margin-bottom:24px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px;margin-bottom:18px}
.card h2{font-size:17px;margin:0 0 14px;padding-left:10px;border-left:4px solid #2563eb}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px}
.kpi .l{font-size:12px;color:var(--mut)}.kpi .v{font-size:20px;font-weight:700;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
th{background:#f9fafb;color:var(--mut);font-weight:600;font-size:12px}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.up{color:var(--up);font-weight:600}.down{color:var(--down);font-weight:600}
ul{margin:0;padding-left:20px}li{margin:6px 0}
.tag{display:inline-block;background:#eff6ff;color:#1d4ed8;border-radius:6px;padding:2px 10px;font-size:12px;margin-bottom:10px}
.disc{margin-top:26px;padding:14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;font-size:12px;color:#9a3412}
</style></head><body><div class="wrap">
<h1>A股市场分析报告</h1>
<div class="meta">报告生成时间：${esc(new Date(r.generatedAt).toLocaleString('zh-CN'))} · 数据日期：${esc(r.dataDate)} · 数据来源：${esc(r.source)}</div>

<div class="kpis">
  <div class="kpi"><div class="l">市场状态</div><div class="v">${esc(r.regime)}</div></div>
  <div class="kpi"><div class="l">综合评分</div><div class="v">${r.totalScore === null ? '--' : r.totalScore}</div></div>
  <div class="kpi"><div class="l">上涨家数占比</div><div class="v">${(r.breadth && r.breadth.overview && r.breadth.overview.upRatio) !== null ? r.breadth.overview.upRatio + '%' : '--'}</div></div>
  <div class="kpi"><div class="l">两市成交额</div><div class="v">${S.fmtCnAmount(r.breadth && r.breadth.amount)}</div></div>
</div>

<div class="card"><h2>一、市场概览</h2><p>${esc(r.indexText)}</p>
<table><thead><tr><th>指数</th><th>点位</th><th>涨跌幅</th><th>成交额</th><th>5日</th><th>20日</th><th>年初至今</th></tr></thead><tbody>${idxRows}</tbody></table></div>

<div class="card"><h2>二、市场画像评分</h2>
<table><thead><tr><th>维度</th><th>得分</th><th>状态</th></tr></thead><tbody>${dimRows}</tbody></table></div>

<div class="card"><h2>三、涨跌分布</h2>
<table><thead><tr><th>涨跌幅区间</th><th>家数</th><th>方向</th></tr></thead><tbody>${bins}</tbody></table>
<p style="margin-top:12px">${esc((r.breadth && r.breadth.sentiment && r.breadth.sentiment.label) || '')}</p></div>

<div class="card"><h2>四、板块轮动</h2>
<h3 style="font-size:14px;margin:0 0 8px">行业涨幅榜 TOP10</h3>
<table><thead><tr><th>#</th><th>板块</th><th>涨跌幅</th><th>主力净流入</th></tr></thead><tbody>${secRows(r.sectors && r.sectors.top)}</tbody></table>
<h3 style="font-size:14px;margin:18px 0 8px">主力资金净流入榜 TOP10</h3>
<table><thead><tr><th>#</th><th>板块</th><th>涨跌幅</th><th>主力净流入</th></tr></thead><tbody>${secRows(r.sectors && r.sectors.flow)}</tbody></table>
<h3 style="font-size:14px;margin:18px 0 8px">行业跌幅榜</h3>
<table><thead><tr><th>#</th><th>板块</th><th>涨跌幅</th><th>主力净流入</th></tr></thead><tbody>${secRows(r.sectors && r.sectors.bottom)}</tbody></table></div>

<div class="card"><h2>五、多空研判</h2>
<p><span class="tag">支撑因素</span></p><ul>${li(r.pros)}</ul>
<p style="margin-top:14px"><span class="tag" style="background:#fef2f2;color:#b91c1c">压制因素</span></p><ul>${li(r.cons)}</ul></div>

<div class="card"><h2>六、策略建议</h2><ul>${li(r.strategy)}</ul></div>

<div class="disc">⚠️ ${esc(r.disclaimer)}</div>
</div></body></html>`;

  const name = `market-report-${String(r.dataDate).replace(/[^\d-]/g, '')}-${Date.now().toString().slice(-5)}.html`;
  const file = path.join(REPORT_DIR, name);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

// ---------- 请求分发 ----------

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const q = parsed.query || {};

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 报告文件静态访问
  if (pathname.startsWith('/reports/')) {
    const f = path.join(REPORT_DIR, path.basename(pathname));
    return fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }

  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);

  const method = req.method.toUpperCase();
  for (const [rm, rx, handler] of routes) {
    if (rm !== method) continue;
    const m = pathname.match(rx);
    if (!m) continue;
    const t0 = Date.now();
    try {
      const body = method === 'POST' ? await readBody(req) : {};
      // 关键：POST 处理器的第二个参数必须是请求体 body；
      // 此前误传 q（query），导致所有 POST 接口的请求体被静默丢弃
      const result = await handler(m, method === 'POST' ? body : q, m, req, res);
      const ms = Date.now() - t0;
      console.log(`[api] ${method} ${pathname} ${ms}ms`);
      return sendJson(res, 200, { ok: true, cost: ms, data: result });
    } catch (e) {
      console.error(`[api] ${method} ${pathname} ERROR:`, e.message);
      return sendJson(res, 500, { ok: false, error: e.message, code: e.code || 'ERR', path: pathname });
    }
  }
  return sendJson(res, 404, { ok: false, error: `未找到接口: ${method} ${pathname}` });
});

// ---------- 定时巡检（自动收集 + 推送） ----------

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS) || 10 * 60 * 1000;

async function scheduledScan() {
  try {
    const r = await S.scanNotifications(store);
    if (r.created) console.log(`[scan] 新增通知 ${r.created} 条（扫描命中 ${r.scanned}）`);
  } catch (e) {
    console.warn('[scan] 巡检失败:', e.message);
  }
}

server.listen(PORT, HOST, async () => {
  console.log('');
  console.log('  ┌────────────────────────────────────────────────┐');
  console.log('  │   金融信息聚合平台 · Finance Hub               │');
  console.log('  └────────────────────────────────────────────────┘');
  console.log(`  访问地址   http://${HOST}:${PORT}`);
  console.log(`  数据源     westock CLI (${W.WESTOCK_BIN})`);
  console.log(`  自动巡检   每 ${Math.round(SCAN_INTERVAL_MS / 60000)} 分钟一次`);
  console.log('  AI 选股    每日 08:30（北京时间）自动分析');
  console.log('');
  // 启动后延迟执行首次巡检，避免与首屏请求竞争
  setTimeout(scheduledScan, 4000);
  setInterval(scheduledScan, SCAN_INTERVAL_MS);
  scheduleDailyPick();
});

process.on('SIGINT', () => { console.log('\n正在关闭服务 ...'); server.close(() => process.exit(0)); });
