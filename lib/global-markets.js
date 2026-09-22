'use strict';
/**
 * global-markets.js — 贵金属与外汇板块
 *
 * 数据能力（全部实测确认）：
 *   贵金属：hf_XAU 伦敦金现货、hf_XAG 伦敦银现货 —— 实时报价可用（quote），
 *           但 CLI 对 hf_ 前缀不支持 K 线与分时 → 历史走势改用境内跟踪基金作代理：
 *             黄金 → sh518880 华安黄金ETF（跟踪人民币金价）
 *             白银 → sz161226 国投白银LOF（跟踪白银期货）
 *           代理口径在响应中显式标注，替换真实历史数据时仅需换 code。
 *   外汇：  fx 前缀品种 —— quote（实时汇率）、kline（日K）、minute（分时）均支持；
 *           品种清单由 `forex list` 动态获取。
 *   全球指数（国际形势板块共用）：usDJI / usIXIC / usINX / hkHSI。
 */

const W = require('./westock');
const A = require('./analytics');

const clean = (v) => (v === '--' || v === '-' || v === '' ? null : v);

/** 贵金属品种定义（现货实时价 + 历史走势代理） */
const METALS = [
  {
    key: 'gold', spotCode: 'hf_XAU', proxyCode: 'sh518880', proxyName: '华安黄金ETF',
    name: '伦敦金现货', unit: '美元/盎司',
    note: '现货报价为伦敦金（美元计价）；历史走势以境内华安黄金ETF为代理（跟踪人民币金价，受汇率影响与伦敦金美元价存在差异）。',
  },
  {
    key: 'silver', spotCode: 'hf_XAG', proxyCode: 'sz161226', proxyName: '国投白银LOF',
    name: '伦敦银现货', unit: '美元/盎司',
    note: '现货报价为伦敦银（美元计价）；历史走势以境内国投白银LOF为代理（跟踪白银期货，存在跟踪偏差）。',
  },
];

/** 外汇品种展示元数据（代码 → 分类与说明） */
const FX_META = {
  fxUSDCNY: { group: '人民币系', label: '美元兑人民币', hint: '在岸人民币汇率，影响进出口与北向资金' },
  fxCNH: { group: '人民币系', label: '离岸人民币', hint: '离岸市场定价，对政策与资金流更敏感' },
  fxEURCNY: { group: '人民币系', label: '欧元兑人民币', hint: '中欧贸易相关' },
  fxHKDCNY: { group: '人民币系', label: '港币兑人民币', hint: '与港股投资换汇成本直接相关' },
  fxCNYJPY: { group: '人民币系', label: '人民币兑日元', hint: '中日贸易与旅游相关' },
  fxDINIW: { group: '美元系', label: '美元指数', hint: '美元对六种主要货币的综合强弱，全球风险偏好的锚' },
  fxEURUSD: { group: '主要货币对', label: '欧元兑美元', hint: '全球交易量最大的货币对' },
  fxUSDJPY: { group: '主要货币对', label: '美元兑日元', hint: '对日央行政策与套息交易敏感' },
  fxGBPUSD: { group: '主要货币对', label: '英镑兑美元', hint: '对英国通胀与央行政策敏感' },
  fxUSDHKD: { group: '主要货币对', label: '美元兑港币', hint: '联系汇率制下窄幅波动' },
};

/** 全球指数（国际形势板块快照与全球行情页共用） */
const GLOBAL_INDICES = [
  { code: 'usDJI', name: '道琼斯工业指数', market: '美股' },
  { code: 'usINX', name: '标普500', market: '美股' },
  { code: 'usIXIC', name: '纳斯达克综合', market: '美股' },
  { code: 'hkHSI', name: '恒生指数', market: '港股' },
];

/** 统一解析 quote 行 → 展示对象 */
function parseQuoteRow(r) {
  return {
    code: clean(r.code),
    name: clean(r.name),
    price: W.toNum(r.price !== undefined ? r.price : r.lastPrice),
    changePct: W.toNum(r.changePct !== undefined ? r.changePct : r.change_percent),
    change: W.toNum(r.priceChange !== undefined ? r.priceChange : r.change),
    high: W.toNum(r.high),
    low: W.toNum(r.low),
    open: W.toNum(r.open),
    prevClose: W.toNum(r.prevClose !== undefined ? r.prevClose : r.prev_close),
    currency: clean(r.currency),
    updateTime: clean(r.updateTime),
    isDelayed: r.isDelayed !== undefined && r.isDelayed !== '-' && r.isDelayed !== '',
  };
}

/** 批量行情 → code → 行对象 */
async function quoteMap(codes) {
  const res = await W.quote(codes).catch(() => null);
  const map = {};
  ((res && res.rows) || []).forEach((r) => {
    const p = parseQuoteRow(r);
    if (p.code) map[p.code] = p;
  });
  return map;
}

/** K 线收盘序列（时间正序） */
async function closeSeries(code, limit = 90) {
  const res = await W.kline(code, 'day', limit).catch(() => null);
  const rows = (res && res.rows) || [];
  return rows
    .map((r) => ({ date: clean(r.date), close: W.toNum(r.last), high: W.toNum(r.high), low: W.toNum(r.low) }))
    .filter((x) => x.close !== null);
}

/** 从收盘序列计算走势统计：区间涨跌幅、20 日高低、20 日年化波动率、关键位 */
function trendStats(series) {
  if (series.length < 6) return null;
  const closes = series.map((x) => x.close);
  const last = closes[closes.length - 1];
  const chg = (n) => {
    const i = closes.length - 1 - n;
    return i >= 0 && closes[i] ? A.round(((last - closes[i]) / closes[i]) * 100, 2) : null;
  };
  const win = closes.slice(-20);
  // 20 日对数收益率年化波动率
  let vol = null;
  if (win.length >= 10) {
    const rets = [];
    for (let i = 1; i < win.length; i++) rets.push(Math.log(win[i] / win[i - 1]));
    const sd = A.stddev(rets);
    vol = A.round(sd * Math.sqrt(252) * 100, 2);
  }
  return {
    days: series.length,
    first: series[0].date, lastDate: series[series.length - 1].date,
    chg5d: chg(5), chg20d: chg(20), chg60d: chg(60),
    hi20: A.round(Math.max(...win), 4), lo20: A.round(Math.min(...win), 4),
    hiAll: A.round(Math.max(...closes), 4), loAll: A.round(Math.min(...closes), 4),
    vol20: vol,
    series,
  };
}

// ============================================================
// 贵金属
// ============================================================

/** 贵金属板块：实时报价 + 代理走势 + 波动统计 */
async function metalsBoard() {
  const quotes = await quoteMap(METALS.map((m) => m.spotCode));
  const proxies = await Promise.allSettled(METALS.map((m) => closeSeries(m.proxyCode, 90)));
  const proxyStats = proxies.map((r) => (r.status === 'fulfilled' ? trendStats(r.value) : null));

  const list = METALS.map((m, i) => {
    const q = quotes[m.spotCode] || {};
    return {
      key: m.key,
      code: m.spotCode,
      name: m.name,
      unit: m.unit,
      price: q.price ?? null,
      change: q.change ?? null,
      changePct: q.changePct ?? null,
      high: q.high ?? null,
      low: q.low ?? null,
      open: q.open ?? null,
      prevClose: q.prevClose ?? null,
      currency: q.currency || 'USD',
      updateTime: q.updateTime || null,
      isDelayed: !!q.isDelayed,
      proxy: { code: m.proxyCode, name: m.proxyName },
      trend: proxyStats[i],
      note: m.note,
    };
  });

  return {
    updatedAt: new Date().toISOString(),
    list,
    source: '腾讯自选股数据接口（现货报价实时；历史走势为境内基金代理口径）',
    note: '贵金属现货（hf_ 前缀）暂不支持 K 线与分时，历史走势以境内跟踪基金为代理；现货报价与代理基金计价货币不同（美元 vs 人民币），涨跌幅不可直接混读。',
  };
}

/** 单品种代理走势（供趋势图接口） */
async function metalTrend(key, limit = 90) {
  const m = METALS.find((x) => x.key === key);
  if (!m) throw Object.assign(new Error(`未知贵金属品种：${key}`), { code: 'BAD_PARAM' });
  const series = await closeSeries(m.proxyCode, limit);
  return {
    key, name: m.name, proxy: { code: m.proxyCode, name: m.proxyName },
    unit: '元（境内基金净值口径）',
    stats: trendStats(series),
    source: `K 线来自 ${m.proxyCode}（${m.proxyName}），代理口径`,
  };
}

// ============================================================
// 外汇
// ============================================================

/** 外汇板块：全部品种实时汇率 + 20 日波动统计（日 K 计算得来） */
async function forexBoard({ codes } = {}) {
  const listRes = await W.forexList().catch(() => null);
  const catalog = ((listRes && listRes.rows) || [])
    .map((r) => ({ code: clean(r['代码'] || r.code), name: clean(r['名称'] || r.name) }))
    .filter((x) => x.code);

  const target = (codes && codes.length ? codes : catalog.map((x) => x.code)).slice(0, 12);
  const quotes = await quoteMap(target);

  // 日 K 走势（并发，60 日）用于波动统计
  const klines = await Promise.allSettled(target.map((c) => closeSeries(c, 60)));

  const list = target.map((code, i) => {
    const q = quotes[code] || {};
    const meta = FX_META[code] || {};
    const series = klines[i].status === 'fulfilled' ? klines[i].value : [];
    return {
      code,
      name: q.name || meta.label || clean((catalog.find((x) => x.code === code) || {}).name) || code,
      group: meta.group || '其他',
      hint: meta.hint || null,
      price: q.price ?? null,
      change: q.change ?? null,
      changePct: q.changePct ?? null,
      high: q.high ?? null,
      low: q.low ?? null,
      prevClose: q.prevClose ?? null,
      updateTime: q.updateTime || null,
      trend: trendStats(series),
    };
  });

  const groups = [];
  ['人民币系', '美元系', '主要货币对'].forEach((g) => {
    const items = list.filter((x) => x.group === g);
    if (items.length) groups.push({ key: g, list: items });
  });

  return {
    updatedAt: new Date().toISOString(),
    groups,
    total: list.length,
    source: '腾讯自选股数据接口（forex 品种：实时汇率 + 日 K）',
    note: '汇率为市场中间价口径的实时快照；「波动情况」由近 20 个交易日日 K 收盘价计算（20 日年化波动率与高低区间）。',
  };
}

/** 单货币对走势：日 K（60/120 日）+ 当日分时 */
async function forexTrend(code, limit = 90) {
  if (!/^fx[A-Z]{4,6}$/.test(String(code || ''))) {
    throw Object.assign(new Error(`非法外汇代码：${code}`), { code: 'BAD_PARAM' });
  }
  const [series, minuteRes] = await Promise.all([
    closeSeries(code, limit),
    W.minute(code).catch(() => null),
  ]);
  const minute = ((minuteRes && minuteRes.rows) || [])
    .map((r) => ({ time: clean(r.time), price: W.toNum(r.price) }))
    .filter((x) => x.price !== null);
  return {
    code, name: FX_META[code] ? FX_META[code].label : code,
    hint: FX_META[code] ? FX_META[code].hint : null,
    stats: trendStats(series),
    daily: series,
    minute,
    source: '腾讯自选股数据接口（日 K + 当日分时）',
  };
}

/** 全球指数快照（国际形势板块与全球行情页共用） */
async function globalIndices() {
  const quotes = await quoteMap(GLOBAL_INDICES.map((x) => x.code));
  return {
    updatedAt: new Date().toISOString(),
    list: GLOBAL_INDICES.map((x) => {
      const q = quotes[x.code] || {};
      return {
        code: x.code, name: x.name, market: x.market,
        price: q.price ?? null, changePct: q.changePct ?? null, change: q.change ?? null,
        updateTime: q.updateTime || null,
      };
    }),
    source: '腾讯自选股数据接口',
  };
}

module.exports = { metalsBoard, metalTrend, forexBoard, forexTrend, globalIndices, METALS, FX_META, GLOBAL_INDICES };
