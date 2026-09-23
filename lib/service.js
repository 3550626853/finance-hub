'use strict';
/**
 * service.js — 三大模块的业务服务层
 * 1) 新股消息模块   2) 财报整理模块   3) 市场分析模块
 * 数据源：westock CLI（腾讯自选股数据接口）
 */

const W = require('./westock');
const A = require('./analytics');

const TODAY = () => new Date().toISOString().slice(0, 10);

// ============================================================
// 工具
// ============================================================

const cleanVal = (v) => (v === '--' || v === '-' || v === '' ? null : v);

/** "2026-09-21~2026-09-24" → {start,end} */
function splitDateRange(s) {
  if (!s) return { start: null, end: null };
  const str = String(cleanVal(s) || '');
  if (!str) return { start: null, end: null };
  const parts = str.split('~').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { start: null, end: null };
  return { start: parts[0], end: parts[parts.length - 1] };
}

/** "39.00~44.00" → {low high mid} */
function splitPriceRange(s) {
  if (s === null || s === undefined) return { low: null, high: null, mid: null, text: null };
  const str = String(s).trim();
  if (!str || str === '--') return { low: null, high: null, mid: null, text: null };
  const parts = str.split('~').map((x) => W.toNum(x));
  const nums = parts.filter((x) => x !== null && x > 0);
  if (!nums.length) return { low: null, high: null, mid: null, text: null };
  const low = parts[0] !== null && parts[0] > 0 ? parts[0] : null;
  const high = parts.length > 1 ? (parts[parts.length - 1] > 0 ? parts[parts.length - 1] : null) : low;
  const mid = low !== null && high !== null ? (low + high) / 2 : (low !== null ? low : high);
  return { low, high, mid, text: str };
}

function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const a = new Date(fromDate + 'T00:00:00Z').getTime();
  const b = new Date(toDate + 'T00:00:00Z').getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

const CN_NUM = { 亿: 1e8, 万: 1e4 };

/** "20315.13亿" → 2031513000000 */
function parseCnAmount(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*(亿|万)?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return CN_NUM[m[2]] ? n * CN_NUM[m[2]] : n;
}

/** 保留正负号的中文金额 */
function fmtCnAmount(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(digits)}万亿`;
  if (abs >= 1e8) return `${(n / 1e8).toFixed(digits)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(digits)}万`;
  return n.toFixed(digits);
}

// ============================================================
// 模块一：新股消息
// ============================================================

const STAGE_META = {
  即将发行: { key: 'upcoming', label: '即将发行', tone: 'info', order: 1 },
  今日申购: { key: 'subscribing', label: '今日申购', tone: 'hot', order: 0 },
  申购中: { key: 'subscribing', label: '申购中', tone: 'hot', order: 0 },
  中签结果: { key: 'allotment', label: '中签结果', tone: 'warn', order: 2 },
  即将上市: { key: 'prelist', label: '即将上市', tone: 'hot', order: 0 },
  今日上市: { key: 'listing', label: '今日上市', tone: 'up', order: 0 },
  已上市: { key: 'listed', label: '已上市', tone: 'muted', order: 3 },
  上市: { key: 'listed', label: '已上市', tone: 'muted', order: 3 },
};

const US_STATUS_META = {
  'In Registration': { key: 'upcoming', label: '注册中', tone: 'info' },
  'Expected': { key: 'upcoming', label: '预计发行', tone: 'info' },
  'Priced': { key: 'priced', label: '已定价', tone: 'warn' },
  'Listed': { key: 'listed', label: '已上市', tone: 'muted' },
};

function normalizeIpo(row, market) {
  const today = TODAY();
  /** 带市场前缀的规范代码：港股数据源自带 5 位数字，需补 hk 前缀才能被其它接口识别 */
  const fullCode = (raw) => {
    const c = String(raw || '').trim();
    if (/^(sh|sz|bj|hk|us)/i.test(c)) return c;
    if (/^[A-Za-z].*-US$/.test(c)) return `us${c.replace(/-US$/i, '')}`;
    if (/^\d{1,5}$/.test(c)) return `hk${c.padStart(5, '0')}`;
    return c;
  };
  if (market === 'us') {
    const pr = splitPriceRange(row.priceRange || row.offerPrice);
    const meta = US_STATUS_META[row.status] || { key: 'upcoming', label: row.status || '待定', tone: 'info' };
    return {
      market: 'us', marketLabel: '美股',
      code: row.code, codeFull: fullCode(row.code), name: row.name,
      industry: cleanVal(row.industry) || '未知',
      stage: meta.label, stageKey: meta.key, tone: meta.tone,
      priceLow: pr.low, priceHigh: pr.high, priceMid: pr.mid, priceText: pr.text,
      subscribeStart: null, subscribeEnd: null,
      listingDate: cleanVal(row.listingDate),
      underwriter: cleanVal(row.underwriter),
      daysToSubscribe: null,
      daysToListing: daysBetween(today, cleanVal(row.listingDate)),
      detail: cleanVal(row.offerPrice) ? `发行价区间 ${row.offerPrice}` : '',
    };
  }

  const meta = STAGE_META[row.stage] || { key: 'other', label: row.stage || '未知', tone: 'muted' };
  const sg = splitDateRange(row.sgrq);
  const pr = splitPriceRange(row.price);
  const listDate = cleanVal(row.ssrq);
  return {
    market, marketLabel: market === 'hk' ? '港股' : '沪深',
    code: row.code, codeFull: fullCode(row.code), name: row.name,
    industry: cleanVal(row.hy) || '未知',
    stage: meta.label, stageKey: meta.key, tone: meta.tone,
    priceLow: pr.low, priceHigh: pr.high, priceMid: pr.mid, priceText: pr.text,
    subscribeStart: sg.start, subscribeEnd: sg.end,
    listingDate: listDate,
    underwriter: null,
    daysToSubscribe: sg.start ? daysBetween(today, sg.start) : null,
    daysToListing: listDate ? daysBetween(today, listDate) : null,
    detail: sg.start && sg.end && sg.start !== sg.end ? `申购区间 ${sg.start} ~ ${sg.end}` : (sg.start ? `申购日 ${sg.start}` : ''),
  };
}

async function ipoModule(market = 'hs') {
  const res = await W.ipo(market);
  const rows = res.rows || [];
  const list = rows.map((r) => normalizeIpo(r, market));

  // 阶段分组
  const groups = {};
  list.forEach((x) => {
    const g = groups[x.stageKey] || (groups[x.stageKey] = { key: x.stageKey, label: x.stage, tone: x.tone, items: [] });
    g.items.push(x);
  });
  const groupOrder = ['subscribing', 'upcoming', 'prelist', 'listing', 'allotment', 'priced', 'listed', 'other'];
  const groupList = Object.values(groups).sort(
    (a, b) => groupOrder.indexOf(a.key) - groupOrder.indexOf(b.key) || b.items.length - a.items.length
  );

  // 行业分布
  const indMap = {};
  list.forEach((x) => { if (x.industry !== '未知') indMap[x.industry] = (indMap[x.industry] || 0) + 1; });

  // 未来上市时间轴
  const timeline = list
    .filter((x) => x.listingDate)
    .sort((a, b) => String(a.listingDate).localeCompare(String(b.listingDate)))
    .slice(0, 20)
    .map((x) => ({ date: x.listingDate, name: x.name, code: x.code, market: x.marketLabel, stage: x.stage, tone: x.tone, priceMid: x.priceMid }));

  // 价格分布（有定价的新股）
  const prices = list.map((x) => x.priceMid).filter((x) => x !== null && x > 0);

  return {
    market,
    marketLabel: market === 'hk' ? '港股' : market === 'us' ? '美股' : '沪深',
    updatedAt: res.fetchedAt,
    dataDate: res.fetchedAt ? res.fetchedAt.slice(0, 10) : TODAY(),
    source: '腾讯自选股数据接口',
    total: list.length,
    groups: groupList,
    list,
    stats: {
      total: list.length,
      byStage: groupList.map((g) => ({ label: g.label, key: g.key, count: g.items.length, tone: g.tone })),
      byIndustry: Object.entries(indMap).map(([k, v]) => ({ name: k, count: v })).sort((a, b) => b.count - a.count).slice(0, 12),
      upcoming7d: list.filter((x) => x.daysToSubscribe !== null && x.daysToSubscribe >= 0 && x.daysToSubscribe <= 7).length,
      listing7d: list.filter((x) => x.daysToListing !== null && x.daysToListing >= 0 && x.daysToListing <= 7).length,
      priced: list.filter((x) => x.priceMid !== null && x.priceMid > 0).length,
      industryCount: list.filter((x) => x.industry !== '未知').length,
      avgPrice: prices.length ? A.round(A.mean(prices), 2) : null,
      maxPrice: prices.length ? A.round(Math.max(...prices), 2) : null,
      minPrice: prices.length ? A.round(Math.min(...prices), 2) : null,
      priceHist: A.histogram(prices, 6),
    },
    timeline,
  };
}

/** 跨市场新股汇总（供总览卡片与推送引擎使用） */
async function ipoAllMarkets(markets = ['hs', 'hk', 'us']) {
  const results = await Promise.allSettled(markets.map((m) => ipoModule(m)));
  const out = {};
  results.forEach((r, i) => {
    const m = markets[i];
    out[m] = r.status === 'fulfilled' ? r.value : { market: m, error: String(r.reason && r.reason.message || r.reason), list: [], total: 0, groups: [], stats: { byStage: [] } };
  });
  return out;
}

// ============================================================
// 模块二：财报整理
// ============================================================

const INCOME_KEEP = {
  OperatingRevenue: '营业总收入', OperatingCost: '营业成本', OperatingProfit: '营业利润', TotalProfit: '利润总额',
  NPParentCompanyOwners: '归母净利润', BasicEPS: '基本每股收益', NetProfitRatio: '销售净利率(%)',
  GrossIncomeRatio: '销售毛利率(%)', ROE: '净资产收益率(%)', ROEWeighted: '加权ROE(%)', ROA: '总资产报酬率(%)',
  ROIC: '投入资本回报率(%)', RAndD: '研发费用', EBIT: '息税前利润', NPParentCompanyYOY: '归母净利同比(%)',
  OperatingRevenueGrowRate_Q: '营收环比增速(%)', TORGrowRate: '营收同比增长(%)', DividendTTM: '股息TTM',
  NPParentCompanyOwnersTTM: '归母净利TTM', OperatingRevenueTTM: '营收TTM', EPSTTM: '每股收益TTM',
};

const BALANCE_KEEP = {
  TotalCurrentAssets: '流动资产合计', TotalNonCurrentAssets: '非流动资产合计', TotalLiability: '负债合计',
  TotalShareholderEquity: '股东权益合计', DebtAssetsRatio: '资产负债率(%)', CurrentRatio: '流动比率',
  QuickRatio: '速动比率', CashEquivalents: '货币资金', WorkingCapital: '营运资本',
  InterestBearDebt: '有息负债', SEWithoutMI: '归母股东权益', TotalAssetTRate: '总资产周转率',
};

const CASH_KEEP = {
  NetOperateCashFlow: '经营活动现金流净额', NetInvestCashFlow: '投资活动现金流净额',
  NetFinanceCashFlow: '筹资活动现金流净额', FCFF: '企业自由现金流', NetCashFlowTTM: '现金流净额TTM',
  GoodsSaleServiceRenderCash: '销售商品收到现金', OperCashFlowPS: '每股经营现金流',
};

function pickFields(row, map) {
  const out = {};
  for (const [k, label] of Object.entries(map)) {
    if (row[k] === undefined) continue;
    const n = W.toNum(row[k]);
    out[k] = { label, value: n !== null ? n : cleanVal(row[k]) };
  }
  return out;
}

function normalizeCompany(code, tables, name) {
  const byTitle = {};
  (tables || []).forEach((t) => { if (t.title) byTitle[t.title] = t.rows || []; });

  const incomeRows = byTitle['利润表'] || [];
  const balanceRows = byTitle['资产负债表'] || [];
  const cashRows = byTitle['现金流量表'] || [];

  const periodIdx = new Map();
  const touch = (endDate) => {
    if (!periodIdx.has(endDate)) periodIdx.set(endDate, { endDate, income: {}, balance: {}, cash: {}, metrics: {} });
    return periodIdx.get(endDate);
  };

  incomeRows.forEach((r) => { const e = cleanVal(r.EndDate); if (e) touch(e).income = pickFields(r, INCOME_KEEP); });
  balanceRows.forEach((r) => { const e = cleanVal(r.EndDate); if (e) touch(e).balance = pickFields(r, BALANCE_KEEP); });
  cashRows.forEach((r) => { const e = cleanVal(r.EndDate); if (e) touch(e).cash = pickFields(r, CASH_KEEP); });

  const periods = [...periodIdx.values()]
    .sort((a, b) => String(b.endDate).localeCompare(String(a.endDate)))
    .map((p) => {
      const g = (sec, key) => (p[sec][key] ? p[sec][key].value : null);
      const rev = g('income', 'OperatingRevenue');
      const np = g('income', 'NPParentCompanyOwners');
      const ocf = g('cash', 'NetOperateCashFlow');
      const gross = g('income', 'GrossIncomeRatio');
      const netM = g('income', 'NetProfitRatio');
      const roe = g('income', 'ROE');
      const roa = g('income', 'ROA');
      const debt = g('balance', 'DebtAssetsRatio');
      return {
        ...p,
        reportLabel: quarterLabel(p.endDate),
        reportType: (quarterLabel(p.endDate).match(/一季报|半年报|三季报|年报/) || [null])[0],
        quarterSeq: quarterSeq(p.endDate),
        // metrics 为「年内累计」口径，与财报原文一致
        metrics: {
          revenue: rev, netProfit: np, operateCashFlow: ocf,
          grossMargin: gross, netMargin: netM, roe, roa, debtRatio: debt,
          eps: g('income', 'BasicEPS'),
          cashToProfit: (ocf !== null && np !== null && np !== 0) ? A.round(ocf / np, 2) : null,
          revenueYoy: g('income', 'TORGrowRate'),
          profitYoy: g('income', 'NPParentCompanyYOY'),
        },
      };
    });

  // 由累计值推导「单季」口径：单季 = 本期累计 − 上一报告期累计（同一会计年度内）
  periods.forEach((p, i) => {
    const prev = periods[i + 1];
    const sameYear = prev && String(prev.endDate).slice(0, 4) === String(p.endDate).slice(0, 4);
    const contiguous = sameYear && prev.quarterSeq !== null && p.quarterSeq !== null && prev.quarterSeq === p.quarterSeq - 1;
    const sub = (a, b) => (typeof a === 'number' && typeof b === 'number' ? A.round(a - b, 2) : null);
    if (p.quarterSeq === 1) {
      // 一季报累计值本身即单季值
      p.single = { revenue: p.metrics.revenue, netProfit: p.metrics.netProfit, operateCashFlow: p.metrics.operateCashFlow };
    } else if (contiguous) {
      p.single = {
        revenue: sub(p.metrics.revenue, prev.metrics.revenue),
        netProfit: sub(p.metrics.netProfit, prev.metrics.netProfit),
        operateCashFlow: sub(p.metrics.operateCashFlow, prev.metrics.operateCashFlow),
      };
    } else {
      p.single = { revenue: null, netProfit: null, operateCashFlow: null };
    }
  });

  // 同比：与 4 个季度前对比
  periods.forEach((p, i) => {
    const base = periods[i + 4];
    if (base) {
      const br = base.metrics.revenue, bn = base.metrics.netProfit;
      p.metrics.revenueYoyCalc = (br && p.metrics.revenue) ? A.round(((p.metrics.revenue - br) / Math.abs(br)) * 100, 2) : null;
      p.metrics.profitYoyCalc = (bn && p.metrics.netProfit) ? A.round(((p.metrics.netProfit - bn) / Math.abs(bn)) * 100, 2) : null;
    }
  });

  // 单季环比：与上一报告期的单季值对比
  periods.forEach((p, i) => {
    const prev = periods[i + 1];
    if (prev && p.single && prev.single) {
      const pr = prev.single.revenue, pn = prev.single.netProfit;
      p.metrics.revenueQoq = (pr && p.single.revenue) ? A.round(((p.single.revenue - pr) / Math.abs(pr)) * 100, 2) : null;
      p.metrics.profitQoq = (pn && p.single.netProfit) ? A.round(((p.single.netProfit - pn) / Math.abs(pn)) * 100, 2) : null;
    } else {
      p.metrics.revenueQoq = null;
      p.metrics.profitQoq = null;
    }
  });

  // 质量评分
  const latest = periods[0];
  let score = 5; const notes = [];
  if (latest) {
    const m = latest.metrics;
    const R2 = (v) => A.round(v, 2);
    if (m.roe !== null) { if (m.roe >= 15) { score += 1.2; notes.push(`ROE ${R2(m.roe)}%，股东回报优秀`); } else if (m.roe >= 8) { score += 0.5; notes.push(`ROE ${R2(m.roe)}%，股东回报良好`); } else if (m.roe < 0) { score -= 1.5; notes.push(`ROE ${R2(m.roe)}%，股东回报为负`); } else notes.push(`ROE ${R2(m.roe)}%，股东回报偏弱`); }
    if (m.grossMargin !== null) { if (m.grossMargin >= 40) { score += 0.8; notes.push(`毛利率 ${R2(m.grossMargin)}%，产品议价能力强`); } else if (m.grossMargin < 15) { score -= 0.6; notes.push(`毛利率 ${R2(m.grossMargin)}%，盈利空间偏薄`); } }
    if (m.debtRatio !== null) { if (m.debtRatio <= 40) { score += 0.6; notes.push(`资产负债率 ${R2(m.debtRatio)}%，财务结构稳健`); } else if (m.debtRatio >= 70) { score -= 1.0; notes.push(`资产负债率 ${R2(m.debtRatio)}%，杠杆偏高`); } }
    if (m.cashToProfit !== null) { if (m.cashToProfit >= 1) { score += 0.8; notes.push(`经营现金流/净利润 ${R2(m.cashToProfit)}，利润含金量高`); } else if (m.cashToProfit < 0.5) { score -= 0.8; notes.push(`经营现金流/净利润 ${R2(m.cashToProfit)}，利润现金含量偏低`); } }
    if (m.revenueYoy !== null) { if (m.revenueYoy > 10) { score += 0.8; notes.push(`营收同比 +${R2(m.revenueYoy)}%，成长性突出`); } else if (m.revenueYoy < 0) { score -= 0.8; notes.push(`营收同比 ${R2(m.revenueYoy)}%，收入承压`); } }
    if (m.profitYoy !== null) { if (m.profitYoy > 10) { score += 0.6; notes.push(`归母净利同比 +${R2(m.profitYoy)}%，盈利扩张`); } else if (m.profitYoy < -10) { score -= 0.8; notes.push(`归母净利同比 ${R2(m.profitYoy)}%，盈利收缩`); } }
  }
  score = Math.max(0, Math.min(10, score));

  return {
    code, name: name || code,
    reportCount: periods.length,
    latestPeriod: latest ? latest.endDate : null,
    periods,
    score: A.round(score, 1),
    grade: score >= 8 ? 'A' : score >= 6.5 ? 'B' : score >= 5 ? 'C' : score >= 3.5 ? 'D' : 'E',
    notes,
    series: periods.slice().reverse().map((p) => ({
      label: p.reportLabel,
      endDate: p.endDate,
      // 单季口径（由累计值推导），趋势图与环比使用
      revenue: p.single ? p.single.revenue : null,
      netProfit: p.single ? p.single.netProfit : null,
      operateCashFlow: p.single ? p.single.operateCashFlow : null,
      // 累计口径（财报原文）
      revenueYtd: p.metrics.revenue,
      netProfitYtd: p.metrics.netProfit,
      operateCashFlowYtd: p.metrics.operateCashFlow,
      // 比率类
      roe: p.metrics.roe, grossMargin: p.metrics.grossMargin,
      netMargin: p.metrics.netMargin, debtRatio: p.metrics.debtRatio,
      revenueYoy: p.metrics.revenueYoy, profitYoy: p.metrics.profitYoy,
    })),
  };
}

/**
 * 报告期标签。A 股财报为「年内累计」口径：
 *   03-31→一季报  06-30→半年报  09-30→三季报  12-31→年报
 */
function quarterLabel(endDate) {
  if (!endDate) return '--';
  const [y, m] = String(endDate).split('-');
  const map = { '03': '一季报', '06': '半年报', '09': '三季报', '12': '年报' };
  return `${y}${map[m] || m}`;
}

/** 报告期在年内的序位 1..4，用于推导单季数据 */
function quarterSeq(endDate) {
  const m = String(endDate).split('-')[1];
  return { '03': 1, '06': 2, '09': 3, '12': 4 }[m] || null;
}

/**
 * 公司主营业务与收入结构（财报整理「主营业务」卡片数据源）。
 *
 * 数据能力（实测确认）：
 *   - `profile` 命令提供主营业务描述（business）、所属行业、董事长、成立/上市日期、
 *     注册资本、办公地址、官网等公司档案（A股、港股、美股；港股另含 introduction 长简介）。
 *   - **数据源不提供分产品 / 分业务的收入明细**（利润表 83 字段中无分部数据），
 *     因此无法给出「各业务收入占比」——这里以利润表的收入-成本费用结构作为补充口径
 *     （营业成本 / 销售费用 / 管理费用 / 研发费用 / 财务费用占营业总收入比），并在响应中显式声明该局限。
 */
async function companyBusiness(code) {
  const [prof, finAll] = await Promise.all([
    W.profile(code).catch(() => null),
    W.finance(code, 1, 'all').catch(() => null),
  ]);

  const row = (prof && prof.rows && prof.rows[0]) || {};
  const g = (k) => cleanVal(row[k]);
  const date = (v) => {
    const s = cleanVal(v);
    return s ? String(s).slice(0, 10) : null;
  };

  // 主营业务描述 → 业务要点（按中文分号 / 句号拆分，过滤过短片段）
  const bizText = g('business');
  const points = String(bizText || '')
    .split(/[；;。\n]+/)
    .map((x) => x.replace(/^[,，、\s]+|[,，、\s]+$/g, ''))
    .filter((x) => x.length >= 4)
    .slice(0, 8);

  // 最新报告期收入-成本费用结构（合并利润表口径）
  let structure = null;
  const incomeTable = ((finAll && finAll.tables) || []).find((t) => /利润|income/i.test(t.title || '') || (t.rows || []).some((r) => r._type === 'income'));
  const incRow = (incomeTable && incomeTable.rows && incomeTable.rows[0]) || null;
  if (incRow) {
    const num = (k) => W.toNum(incRow[k]);
    const rev = num('OperatingRevenue');
    if (rev && rev > 0) {
      const pctOfRev = (v) => (v === null ? null : A.round((v / rev) * 100, 2));
      const cost = num('OperatingCost');
      const items = [
        { key: 'cost', label: '营业成本', value: cost, pctOfRev: pctOfRev(cost) },
        { key: 'sale', label: '销售费用', value: num('OperatingExpense'), pctOfRev: pctOfRev(num('OperatingExpense')) },
        { key: 'admin', label: '管理费用', value: num('TotalAdminExpense'), pctOfRev: pctOfRev(num('TotalAdminExpense')) },
        { key: 'rd', label: '研发费用', value: num('RAndD'), pctOfRev: pctOfRev(num('RAndD')) },
        { key: 'fin', label: '财务费用', value: num('FinancialExpense'), pctOfRev: pctOfRev(num('FinancialExpense')) },
      ].filter((x) => x.value !== null);
      structure = {
        endDate: cleanVal(incRow.EndDate),
        revenue: rev,
        grossMargin: num('GrossIncomeRatio'),
        grossProfit: cost !== null ? A.round(rev - cost, 2) : null,
        items,
      };
    }
  }

  return {
    code: g('code') || code,
    name: g('name') || code,
    business: bizText,
    businessPoints: points,
    introduction: g('introduction'),
    profile: {
      industry: g('industry'),
      sector: g('sector'),
      chairman: g('chairman'),
      establishDate: date(row.establishDate),
      listedDate: date(row.listedDate),
      regCapitalWan: W.toNum(row.regCapital),           // 单位：万元（A股）
      officeAddress: g('officeAddress'),
      regAddress: g('regAddress'),
      website: g('website'),
      tel: g('tel'),
    },
    structure,
    segmentNote: '数据源未提供分产品 / 分业务的收入明细，故无法给出各业务收入占比；上述结构为合并利润表的「收入-成本费用」口径。',
    updatedAt: new Date().toISOString(),
    source: '腾讯自选股数据接口（profile 股票简况 + 合并利润表）',
  };
}

async function companyFinance(code, { periods = 12, fields = 'all' } = {}) {
  const [fin, q] = await Promise.all([
    W.finance(code, periods, fields),
    W.quote(code).catch(() => null),
  ]);
  const name = q && q.rows && q.rows[0] ? q.rows[0].name : code;
  const data = normalizeCompany(code, fin.tables, name);
  data.updatedAt = fin.fetchedAt;
  if (q && q.rows && q.rows[0]) {
    const r = q.rows[0];
    data.quote = {
      price: W.toNum(r.price), changePct: W.toNum(r.change_percent),
      pe: W.toNum(r.pe_ratio), pb: W.toNum(r.pb_ratio),
      // 总市值：数据源单位为元，归一化为亿元（展示层 ×1e8 还原）
      marketCap: A.normCap(r.total_market_cap),   // 单位自适应（元/亿元漂移，见 analytics.normCap）
      dividendYield: W.toNum(r.dividend_ratio_ttm),
    };
  }
  return data;
}

/** 多公司横向对比 */
async function compareFinance(codes, { periods = 8 } = {}) {
  const list = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  const results = await Promise.allSettled(list.map((c) => companyFinance(c, { periods, fields: 'all' })));
  const companies = results.map((r, i) => (r.status === 'fulfilled' ? r.value : { code: list[i], name: list[i], error: String(r.reason && r.reason.message || r.reason), periods: [], series: [], metrics: {} }));  const METRICS = [
    { key: 'revenue', label: '营业收入', unit: '元', better: 'high' },
    { key: 'netProfit', label: '归母净利润', unit: '元', better: 'high' },
    { key: 'grossMargin', label: '销售毛利率', unit: '%', better: 'high' },
    { key: 'netMargin', label: '销售净利率', unit: '%', better: 'high' },
    { key: 'roe', label: '净资产收益率', unit: '%', better: 'high' },
    { key: 'roa', label: '总资产报酬率', unit: '%', better: 'high' },
    { key: 'debtRatio', label: '资产负债率', unit: '%', better: 'low' },
    { key: 'operateCashFlow', label: '经营现金流净额', unit: '元', better: 'high' },
    { key: 'cashToProfit', label: '现金流/净利润', unit: '倍', better: 'high' },
    { key: 'revenueYoy', label: '营收同比', unit: '%', better: 'high' },
    { key: 'profitYoy', label: '归母净利同比', unit: '%', better: 'high' },
    { key: 'eps', label: '基本每股收益', unit: '元', better: 'high' },
  ];

  const table = METRICS.map((m) => {
    const cells = companies.map((c) => {
      const p = c.periods && c.periods[0];
      return p && p.metrics ? p.metrics[m.key] : null;
    });
    const valid = cells.filter((x) => x !== null && Number.isFinite(x));
    let bestIdx = -1;
    if (valid.length > 1) {
      const target = m.better === 'high' ? Math.max(...valid) : Math.min(...valid);
      bestIdx = cells.findIndex((x) => x === target);
    }
    return { key: m.key, label: m.label, unit: m.unit, better: m.better, cells, bestIdx, avg: A.round(A.mean(valid), 2) };
  });

  return {
    updatedAt: new Date().toISOString(),
    codes: list,
    companies: companies.map((c) => ({
      code: c.code, name: c.name, error: c.error || null,
      latestPeriod: c.latestPeriod, score: c.score, grade: c.grade,
      quote: c.quote || null, notes: c.notes || [], series: c.series || [],
      metrics: (c.periods && c.periods[0] ? c.periods[0].metrics : {}),
    })),
    metrics: table,
  };
}

/** 全市场财报披露日历 */
async function reportCalendar(market = 'hs', limit = 40) {
  const res = await W.calendar('financial_report', market, limit);
  const rows = res.rows || [];
  return {
    market, updatedAt: res.fetchedAt,
    list: rows.map((r) => ({
      date: cleanVal(r.date), code: cleanVal(r.symbol), name: cleanVal(r.stockName) || cleanVal(r.name),
      market: cleanVal(r.market), price: W.toNum(r.price),
      daysLeft: daysBetween(TODAY(), cleanVal(r.date)),
    })),
  };
}

// ============================================================
// 新股上市表现分析（暴涨 / 破发）
// ============================================================

/**
 * 判定阈值（单位 %，全部相对「发行价」）
 * 首日与「上市后区间」分开设阈：
 *  · 首日 —— A 股主板首日有 44% 涨停上限，创业板 / 科创板 / 港股无涨跌幅限制，
 *    故首日收盘 >= +100% 才记「暴涨」；跌破发行价（留 ±0.5% 缓冲）记「破发」。
 *  · 区间 —— 最新价相对发行价 >= +100% 记「暴涨」，<= -0.5% 记「破发」，<= -20% 记「深度破发」。
 *  · 合并 —— 以「最新」为主：最新破发即破发；最新平稳但首日暴涨/破发，按首日升级；
 *    这样「曾出现」不会漏报，同时当前状态不会被历史遮蔽。
 */
const IPO_PERF = {
  firstDay: { surge: 100, break: -0.5 },
  range: { surge: 100, break: -0.5, deepBreak: -20 },
  klineLimit: 180, // 覆盖上市后约 9 个月日线，足以定位上市首日
};

const PERF_META = {
  surge: { tone: 'up', label: '暴涨', tagTone: 'tag-up', cls: 'up' },
  break: { tone: 'down', label: '破发', tagTone: 'tag-down', cls: 'down' },
  normal: { tone: 'muted', label: '平稳', tagTone: 'tag-muted', cls: 'flat' },
  pending: { tone: 'muted', label: '未上市', tagTone: 'tag-muted', cls: 'dim' },
  unknown: { tone: 'muted', label: '待判定', tagTone: 'tag-muted', cls: 'dim' },
};

const PERF_CUR = { hs: '元', hk: '港元', us: '美元' };

/** 相对发行价的涨跌幅；价格或发行价非法时返回 null（杜绝除零 / 空值误判） */
function perfPct(price, issue) {
  const p = Number(price);
  const i = Number(issue);
  if (!Number.isFinite(p) || !Number.isFinite(i) || i <= 0 || p <= 0) return null;
  return A.round(((p - i) / i) * 100, 2);
}

function perfPctText(v) { return v === null || v === undefined ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`; }
function perfPriceText(v) { return v === null || v === undefined ? '--' : Number(v).toFixed(2); }

/** 单档判定：surge / break / normal */
function perfJudge(pct, th) {
  if (pct === null || pct === undefined) return null;
  if (pct >= th.surge) return 'surge';
  if (pct <= th.break) return 'break';
  return 'normal';
}

/** 合并首日与区间：以「最新」为主，首日仅在最新平稳时升级 */
function perfMerge(latest, firstDay) {
  if (latest === 'break') return 'break';
  if (latest === 'surge') return 'surge';
  if (firstDay === 'surge' || firstDay === 'break') return firstDay;
  return 'normal';
}

/**
 * 上市日缺失时的探测：数据源在上市后会逐步把标的移出「今日上市」分组，
 * 此时可复用「上市前伪 K 线」（成交量为 0、收盘价＝发行价）反推发行价与上市日。
 * 探测失败返回 null，调用方按 pending 处理——不做任何猜测式判定。
 */
async function probeListingFromKline(codeFull) {
  try {
    const [kl, q] = await Promise.all([
      W.kline(codeFull, 'day', IPO_PERF.klineLimit),
      W.quote(codeFull).catch(() => null),
    ]);
    const all = (kl.rows || []).map((r) => ({
      date: cleanVal(r.date),
      close: W.toNum(r.last) !== null ? W.toNum(r.last) : W.toNum(r.close),
      volume: W.toNum(r.volume),
    })).filter((x) => x.date);
    const bars = all.filter((x) => (x.volume || 0) > 0 && x.close > 0);
    // 关键：是否存在「有效成交」才是已上市的判据。部分市场（如港股）没有上市前伪 K 线，
    // 若只认伪 K 线就会把已上市标的误判成未上市。
    if (!bars.length) return { listed: false };
    const ghost = all.find((x) => !(x.volume > 0) && x.close > 0 && String(x.date) < String(bars[0].date));
    let issue = ghost ? Number(ghost.close) : null;
    let source = ghost ? 'kline' : null;
    if (issue === null && bars.length === 1) {
      // 仅一个有效交易日时，昨收即发行价
      const pc = W.toNum(((q && q.rows && q.rows[0]) || {}).prev_close);
      if (pc !== null && pc > 0) { issue = pc; source = 'quote'; }
    }
    return { listed: true, issuePrice: issue, listingDate: bars[0].date, source };
  } catch (_) { return null; }
}

function perfMarketOf(codeFull) {
  const c = String(codeFull || '');
  if (/^hk/i.test(c)) return 'hk';
  if (/^us/i.test(c)) return 'us';
  return 'hs';
}

function perfShell(t) {
  const codeFull = (t && (t.codeFull || t.code)) || '';
  return {
    status: 'unknown', verdict: 'unknown', tone: 'muted', label: '待判定', tagTone: 'tag-muted', cls: 'dim',
    code: (t && t.code) || codeFull, codeFull, name: (t && t.name) || null,
    market: (t && t.market) || perfMarketOf(codeFull),
    issuePrice: null, issuePriceSource: null, issuePriceIsRange: false, issuePriceText: null,
    listingDate: (t && t.listingDate) || null, listingDateApprox: false, daysToListing: null,
    firstDayDate: null, firstDayClose: null, firstDayPct: null, firstDayApprox: false,
    latestDate: null, latestPrice: null, latestPct: null,
    highSinceListing: null, lowSinceListing: null, tradingDays: 0,
    severity: null, tag: '待判定', text: '', reason: '',
  };
}

/**
 * 分析单只新股上市后的价格表现（暴涨 / 破发）。
 *
 * 兜底原则（关键）：**无数据绝不判负面**。行情缺失、发行价缺失、尚未上市
 * 一律落到 pending / unknown，绝不因为「价格取到 0」而误判成破发。
 *
 * @param {{code:string,codeFull:string,name:string,listingDate:string|null,
 *          priceMid:number|null,priceLow:number|null,priceHigh:number|null,
 *          priceText:string|null,market:string}} target
 */
async function analyzeIpoPerformance(target) {
  const t = target || {};
  const out = perfShell(t);
  const cur = PERF_CUR[out.market] || '';
  const today = TODAY();

  /** 收尾：按 verdict 补齐展示字段 */
  const finish = (patch) => {
    Object.assign(out, patch);
    const meta = PERF_META[out.verdict] || PERF_META.unknown;
    out.tone = meta.tone; out.label = meta.label; out.tagTone = meta.tagTone; out.cls = meta.cls;
    const p = out.latestPct !== null ? out.latestPct : out.firstDayPct;
    out.tag = (out.verdict === 'surge' || out.verdict === 'break') && p !== null
      ? `${meta.label} ${perfPctText(p)}`
      : meta.label;
    return out;
  };

  // ---- 1) 上市日缺失：日历内标的先探测，日历外标的直接 unknown ----
  // inIpoCalendar === false 表示「不在当前新股日历中」（个股资讯视图里的老股票），
  // 这类标的谈不上上市日，必须走 unknown，不能显示成「未上市」。
  if (!out.listingDate && t.inIpoCalendar !== false && t.probe !== false) {
    const p = await probeListingFromKline(out.codeFull);
    if (p && p.listed) {
      // 已有成交 → 确认已上市；首个有效交易日视为上市日（近似），发行价可能仍缺失
      out.listingDate = p.listingDate;
      out.listingDateApprox = true;
      out.firstDayApprox = true;
      out.issuePrice = p.issuePrice;
      out.issuePriceSource = p.source;
    }
    // 探测显示未上市 / 探测失败 → 落到下方 pending 分支，不做任何猜测
  }
  if (!out.listingDate) {
    return t.inIpoCalendar === false
      ? finish({
        status: 'unknown', verdict: 'unknown', reason: '非新股日历标的',
        text: '该股不在当前新股日历中，缺少发行价与上市日基准，不做暴涨 / 破发判定。',
      })
      : finish({
        status: 'pending', verdict: 'pending', reason: '上市日期未公布',
        text: '尚未上市（上市日期未公布），暂无上市后表现可判定。',
      });
  }
  const d2l = daysBetween(today, out.listingDate);
  if (d2l !== null && d2l > 0) {
    out.daysToListing = d2l;
    return finish({
      status: 'pending', verdict: 'pending', reason: '尚未上市',
      text: `尚未上市（预计 ${out.listingDate} 上市，还有 ${d2l} 天），暂无上市后表现可判定。`,
    });
  }

  // ---- 2) 已过上市日：取日线 + 实时行情 ----
  let kl = null; let q = null;
  try {
    [kl, q] = await Promise.all([
      W.kline(out.codeFull, 'day', IPO_PERF.klineLimit).catch(() => null),
      W.quote(out.codeFull).catch(() => null),
    ]);
  } catch (_) { /* 下方统一按空数据处理 */ }

  const allBars = ((kl && kl.rows) || []).map((r) => ({
    date: cleanVal(r.date),
    open: W.toNum(r.open), close: W.toNum(r.last) !== null ? W.toNum(r.last) : W.toNum(r.close),
    high: W.toNum(r.high), low: W.toNum(r.low), volume: W.toNum(r.volume),
  })).filter((x) => x.date);

  // 有效交易日：上市前的「伪 K 线」volume=0 且 open/high/low=0，必须剔除，
  // 否则会把上市前一日那根（收盘价＝发行价）误当首日，得出 0% 的荒谬结论。
  const bars = allBars.filter((x) => (x.volume || 0) > 0 && x.close > 0);

  const qRow = (q && q.rows && q.rows[0]) || {};
  const quotePrice = W.toNum(qRow.price);

  // ---- 3) 发行价：三级来源（探测所得优先，其次日历定价 → 伪 K 线 → 首日昨收）----
  let issue = out.issuePrice; let issueSource = out.issuePriceSource;
  let issueIsRange = out.issuePriceIsRange; let issueText = out.issuePriceText;
  if (issue !== null && !(issue > 0)) { issue = null; issueSource = null; }
  if (issue === null && t.priceMid !== null && t.priceMid !== undefined && Number(t.priceMid) > 0) {
    issue = Number(t.priceMid);
    issueSource = 'ipo';
    issueIsRange = !!(t.priceLow && t.priceHigh && Number(t.priceLow) !== Number(t.priceHigh));
    issueText = t.priceText || null;
  } else {
    // 上市前伪 K 线：volume=0 但收盘价＝发行价
    const ghost = allBars.find((x) => !(x.volume > 0) && x.close > 0 && String(x.date) <= String(out.listingDate));
    if (ghost) { issue = Number(ghost.close); issueSource = 'kline'; }
  }
  // 仅 1 个有效交易日时，quote.prev_close 即发行价
  if (issue === null && bars.length === 1) {
    const pc = W.toNum(qRow.prev_close);
    if (pc !== null && pc > 0) { issue = pc; issueSource = 'quote'; }
  }

  // ---- 4) 无行情 → 明确 unknown，不判负面 ----
  if (!bars.length) {
    const hasQuote = quotePrice !== null && quotePrice > 0;
    return finish({
      status: 'unknown', verdict: 'unknown',
      issuePrice: issue, issuePriceSource: issueSource, issuePriceIsRange: issueIsRange, issuePriceText: issueText,
      latestPrice: hasQuote ? quotePrice : null,
      reason: hasQuote ? '暂无日线数据' : '暂无上市后行情数据',
      text: hasQuote
        ? `已有报价 ${perfPriceText(quotePrice)}${cur ? ` ${cur}` : ''}，但暂无日线数据，暂不判定暴涨 / 破发。`
        : '暂无可用的上市后行情数据，不做暴涨 / 破发判定。',
    });
  }

  // ---- 5) 首日 / 最新 / 区间极值 ----
  const firstBar = bars.find((x) => String(x.date) === String(out.listingDate)) || bars[0];
  const lastBar = bars[bars.length - 1];
  const highs = bars.map((x) => x.high).filter((x) => x > 0);
  const lows = bars.map((x) => x.low).filter((x) => x > 0);

  out.firstDayDate = firstBar.date;
  out.firstDayClose = firstBar.close;
  out.firstDayApprox = String(firstBar.date) !== String(out.listingDate);
  out.latestDate = lastBar.date;
  out.latestPrice = lastBar.close;
  out.tradingDays = bars.length;
  out.highSinceListing = highs.length ? A.round(Math.max(...highs), 4) : null;
  out.lowSinceListing = lows.length ? A.round(Math.min(...lows), 4) : null;
  out.issuePrice = issue; out.issuePriceSource = issueSource;
  out.issuePriceIsRange = issueIsRange; out.issuePriceText = issueText;

  // ---- 6) 发行价缺失但有行情：给出走势，不做涨跌判定 ----
  if (issue === null || !(issue > 0)) {
    return finish({
      status: 'unknown', verdict: 'unknown', reason: '发行价未知',
      text: `已上市交易 ${out.tradingDays} 个交易日，最新 ${perfPriceText(out.latestPrice)}${cur ? ` ${cur}` : ''}；`
        + '未取到该股发行价，无法计算相对发行价的涨跌，不做暴涨 / 破发判定。',
    });
  }

  const fdPct = perfPct(out.firstDayClose, issue);
  const ltPct = perfPct(out.latestPrice, issue);
  out.firstDayPct = fdPct;
  out.latestPct = ltPct;

  // ---- 7) 判定与文案 ----
  const fdV = perfJudge(fdPct, IPO_PERF.firstDay);
  const ltV = perfJudge(ltPct, IPO_PERF.range);
  const verdict = perfMerge(ltV, fdV);
  out.severity = verdict === 'break' && ltPct !== null && ltPct <= IPO_PERF.range.deepBreak ? 'deep' : null;

  const unit = cur ? ` ${cur}` : '';
  const rangeNote = issueIsRange && issueText ? `（发行价取区间 ${issueText} 中值，以最终定价为准）` : '';
  const fdName = `上市${out.firstDayApprox ? '首个交易日' : '首日'}`;
  // 仅一个交易日时首日即最新，合并表述，避免「最新 / 首日」同一数字说两遍
  const sameDay = String(out.firstDayDate) === String(out.latestDate);
  const priceSeg = sameDay
    ? `${fdName}收 ${perfPriceText(out.latestPrice)}${unit}（${perfPctText(out.latestPct)}）`
    : `最新 ${perfPriceText(out.latestPrice)}${unit}（${perfPctText(out.latestPct)}），${fdName} ${perfPctText(out.firstDayPct)}`;
  const head = `发行价 ${perfPriceText(issue)}${unit} → ${priceSeg}`;

  let text;
  if (verdict === 'surge') {
    text = `${head}，涨幅达 +${IPO_PERF.range.surge}% 以上，判定暴涨。${rangeNote}`;
  } else if (verdict === 'break') {
    text = `${head}，已跌破发行价${out.severity === 'deep' ? `且跌幅超 ${Math.abs(IPO_PERF.range.deepBreak)}%，属深度破发` : ''}。${rangeNote}`;
  } else {
    text = `${head}，未触发暴涨（≥ +${IPO_PERF.range.surge}%）或破发（跌破发行价）。${rangeNote}`;
  }

  return finish({ status: 'ready', verdict, text, reason: '' });
}

/**
 * 为一批资讯批量挂载上市表现。
 * 按证券代码去重，只对「已到上市日」的标的发请求，其余本地判定，避免无效调用。
 */
async function attachIpoPerf(items, targets) {
  const byCode = new Map();
  (targets || []).forEach((t) => {
    const k = t.codeFull || t.code;
    if (k && !byCode.has(k)) byCode.set(k, t);
  });
  const codes = [...byCode.keys()];
  // 未上市 / 无上市日的标的在 analyzeIpoPerformance 内部直接返回，不会发起行情请求
  const settled = await Promise.allSettled(codes.map((c) => analyzeIpoPerformance(byCode.get(c))));
  const map = new Map();
  settled.forEach((r, i) => { map.set(codes[i], r.status === 'fulfilled' ? r.value : perfShell(byCode.get(codes[i]))); });

  (items || []).forEach((x) => {
    const k = x.codeFull || x.code;
    x.perf = map.get(k) || null;
  });
  return map;
}

/**
 * 表现分布的统计（供副标题 / 调试使用）。
 * analyzed 为消息条数；其余字段按「股票去重」统计，避免同一只新股的多条消息被重复计数。
 */
function perfStats(list) {
  const s = { analyzed: 0, stocks: 0, ready: 0, surge: 0, break: 0, normal: 0, pending: 0, unknown: 0 };
  const seen = new Set();
  (list || []).forEach((x) => {
    s.analyzed += 1;
    const p = x && x.perf;
    if (!p) return;
    const k = p.codeFull || p.code || '';
    if (seen.has(k)) return;
    seen.add(k);
    s.stocks += 1;
    s[p.status] = (s[p.status] || 0) + 1;
    if (p.status === 'ready') s[p.verdict] = (s[p.verdict] || 0) + 1;
  });
  return s;
}

// ============================================================
// 模块四：新股资讯（新闻 + 摘要）
// ============================================================

/** 从新闻详情正文中提取摘要：去 Markdown/HTML 标记后按句子边界截断 */
function extractSummary(detailText, maxLen = 118) {
  if (!detailText) return null;
  let t = String(detailText);
  t = t.replace(/^#\s+.*$/m, '');                 // 标题行
  t = t.replace(/^日期:.*$/m, '');                // 日期/来源行
  t = t.replace(/<!--[\s\S]*?-->/g, '');          // HTML 注释
  t = t.replace(/<[^>]+>/g, '');                  // HTML 标签
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');  // Markdown 链接
  t = t.replace(/[*_`>#]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // 详情接口对部分资讯会返回「未找到新闻详情」这类占位文本，不能当作摘要
  if (t.length < 15 || /^(未找到|暂无|无此|没有找到)/.test(t)) return null;
  if (t.length <= maxLen) return t;
  const seg = t.slice(0, maxLen + 40);
  let last = -1;
  for (const ch of ['。', '！', '？', '；']) {
    const i = seg.lastIndexOf(ch);
    if (i > last && i <= maxLen) last = i;
  }
  if (last > maxLen * 0.5) return t.slice(0, last + 1);
  return t.slice(0, maxLen) + '…';
}

/**
 * 新股资讯模块
 * 数据来源：以新股日历中的在发/待发标的为锚点，抓取其个股资讯；
 * 摘要通过「资讯详情」接口取正文首段生成（列表接口的 summary 字段上游为空）。
 * 注：美股暂无个股资讯接口，故仅覆盖沪深与港股。
 */
async function ipoNewsModule({ market = 'all', limit = 30, detailTop = 14 } = {}) {
  const markets = market === 'all' ? ['hs', 'hk'] : [market].filter((m) => m === 'hs' || m === 'hk');
  if (!markets.length) return { market, items: [], total: 0, note: '美股暂无个股资讯数据源', updatedAt: new Date().toISOString() };

  const ipo = await ipoAllMarkets(markets);
  const targets = [];
  Object.values(ipo).forEach((mod) => {
    (mod.list || []).forEach((x) => {
      // 统一使用带市场前缀的规范代码查询（港股代码源自带 5 位数字）
      const query = x.codeFull || x.code;
      targets.push({
        code: x.code, codeFull: query, query, name: x.name, market: x.market, marketLabel: x.marketLabel,
        stage: x.stage, stageKey: x.stageKey, tone: x.tone,
        subscribeStart: x.subscribeStart, listingDate: x.listingDate,
        priceText: x.priceText, priceMid: x.priceMid, priceLow: x.priceLow, priceHigh: x.priceHigh,
      });
    });
  });

  const byMarket = {};
  targets.forEach((t) => { (byMarket[t.market] = byMarket[t.market] || []).push(t.query); });

  const groups = Object.entries(byMarket).filter(([, codes]) => codes.length);
  const results = await Promise.allSettled(groups.map(([, codes]) => W.news(codes, 12)));

  const items = [];
  const seen = new Set();
  results.forEach((r, gi) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    const [, codes] = groups[gi];
    const tables = r.value.tables && r.value.tables.length ? r.value.tables : [];
    tables.forEach((t) => {
      // 批量查询时每个代码一段表格，标题即代码；单代码查询无标题，回退到唯一代码
      let key = String(t.title || '').trim();
      if (!key && codes.length === 1) key = codes[0];
      const target = targets.find((x) => x.query === key) || targets.find((x) => x.code === key);
      (t.rows || []).forEach((row) => {
        const id = cleanVal(row.id);
        if (!id || seen.has(id)) return;
        seen.add(id);
        items.push({
          id,
          source: cleanVal(row.src) || '未知来源',
          time: cleanVal(row.time),
          title: cleanVal(row.title) || '(无标题)',
          url: cleanVal(row.url),
          code: target ? target.code : key,
          codeFull: target ? (target.codeFull || target.code) : key,
          name: target ? target.name : null,
          market: target ? target.market : null,
          marketLabel: target ? target.marketLabel : null,
          stage: target ? target.stage : null,
          tone: target ? target.tone : 'muted',
          subscribeStart: target ? target.subscribeStart : null,
          listingDate: target ? target.listingDate : null,
          priceText: target ? target.priceText : null,
          summary: null,
          summaryFrom: null,
        });
      });
    });
  });

  // 按发布时间倒序
  items.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  const list = items.slice(0, limit);

  // 为最新的若干条补摘要（详情接口），同时按股票维度补齐上市表现（暴涨 / 破发）
  const detailTargets = list.slice(0, detailTop);
  const [details] = await Promise.all([
    Promise.allSettled(detailTargets.map((x) => W.newsDetail(`nes${x.id}`))),
    attachIpoPerf(list, targets),
  ]);
  details.forEach((r, i) => {
    const item = detailTargets[i];
    if (r.status !== 'fulfilled' || !r.value) return;
    const sum = extractSummary(r.value.text);
    if (sum) { item.summary = sum; item.summaryFrom = '资讯正文'; }
  });

  // 关联新股的分布统计
  const byStock = {};
  list.forEach((x) => { if (x.name) byStock[`${x.name}|${x.code}`] = (byStock[`${x.name}|${x.code}`] || 0) + 1; });

  return {
    market,
    updatedAt: new Date().toISOString(),
    total: list.length,
    scannedStocks: targets.length,
    withSummary: list.filter((x) => x.summary).length,
    note: '美股暂无个股资讯数据源',
    stocks: targets.map((t) => ({ code: t.code, codeFull: t.codeFull || t.code, name: t.name, marketLabel: t.marketLabel, stage: t.stage, tone: t.tone })),
    hotStocks: Object.entries(byStock)
      .map(([k, v]) => {
        const [name, code] = k.split('|');
        const t = targets.find((x) => x.code === code);
        return { key: k, name, code, codeFull: t ? (t.codeFull || t.code) : code, newsCount: v };
      })
      .sort((a, b) => b.newsCount - a.newsCount).slice(0, 8),
    list,
    perfStats: perfStats(list),
    perfRule: IPO_PERF,
    source: '腾讯自选股数据接口',
  };
}

/** 归一化资讯查询用的证券代码（港股需补 hk 前缀） */
function normalizeNewsCode(code) {
  const c = String(code || '').trim();
  if (/^(sh|sz|bj|hk|us)/i.test(c)) return c;
  if (/^\d{4,5}$/.test(c)) return `hk${c}`;
  return c;
}

/**
 * 某只股票的全部相关资讯（供「新股资讯 · 热度榜」点击后展开）
 */
async function stockNews(code, { limit = 40, detailTop = 24 } = {}) {
  const norm = normalizeNewsCode(code);
  const isUs = /^us/i.test(norm);
  const [res, q, ipoMap] = await Promise.all([
    W.news(norm, limit).catch(() => null),
    W.quote(norm).catch(() => null),
    ipoAllMarkets(['hs', 'hk']).catch(() => ({})), // 命中 ipo 缓存时几乎零成本
  ]);
  const qRow = (q && q.rows && q.rows[0]) || {};
  const name = cleanVal(qRow.name) || String(code);

  // 在新股日历里定位该股，用于取发行价与上市日（老股票取不到，走 unknown 兜底）
  let ipoTarget = null;
  Object.values(ipoMap || {}).forEach((mod) => {
    (mod.list || []).forEach((x) => {
      if (ipoTarget) return;
      if (String(x.codeFull) === String(norm) || String(x.code) === String(norm)) ipoTarget = x;
    });
  });

  const seen = new Set();
  const list = [];
  ((res && res.tables) || []).forEach((t) => {
    (t.rows || []).forEach((row) => {
      const id = cleanVal(row.id);
      if (!id || seen.has(id)) return;
      seen.add(id);
      list.push({
        id,
        source: cleanVal(row.src) || '未知来源',
        time: cleanVal(row.time),
        title: cleanVal(row.title) || '(无标题)',
        url: cleanVal(row.url),
        summary: null,
      });
    });
  });
  list.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

  const targets = list.slice(0, detailTop);
  const [details, perf] = await Promise.all([
    Promise.allSettled(targets.map((x) => W.newsDetail(`nes${x.id}`))),
    analyzeIpoPerformance({
      code: cleanVal(qRow.code) || norm, codeFull: norm, name,
      market: ipoTarget ? ipoTarget.market : perfMarketOf(norm),
      listingDate: ipoTarget ? ipoTarget.listingDate : null,
      priceMid: ipoTarget ? ipoTarget.priceMid : null,
      priceLow: ipoTarget ? ipoTarget.priceLow : null,
      priceHigh: ipoTarget ? ipoTarget.priceHigh : null,
      priceText: ipoTarget ? ipoTarget.priceText : null,
      // 新股资讯视图点进来的多为刚上市标的，即便已移出日历也允许探测发行价与上市日；
      // 探测不到基准时会落到 unknown，前端不展示，不会误判。
      inIpoCalendar: true,
    }).catch(() => null),
  ]);
  details.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    const s = extractSummary(r.value.text);
    if (s) targets[i].summary = s;
  });

  return {
    code: cleanVal(qRow.code) || norm,
    queryCode: norm,
    name,
    perf,
    market: cleanVal(qRow.market_name),
    price: W.toNum(qRow.price),
    changePct: W.toNum(qRow.change_percent),
    marketCap: A.normCap(qRow.total_market_cap),
    total: list.length,
    withSummary: list.filter((x) => x.summary).length,
    updatedAt: new Date().toISOString(),
    list,
    source: '腾讯自选股数据接口',
    note: isUs
      ? '美股标的暂无个股资讯数据源，此处可能为空；页面下方仍可切换查看其他新股的资讯。'
      : '该接口按个股代码抓取其全部可用资讯；摘要由资讯正文首段自动提取，个别资讯无正文时可点击标题查看原文。',
  };
}

// ============================================================
// 模块三：市场分析
// ============================================================

const INDEX_SET = [
  { code: 'sh000001', name: '上证指数', role: '大盘' },
  { code: 'sz399001', name: '深证成指', role: '大盘' },
  { code: 'sz399006', name: '创业板指', role: '成长' },
  { code: 'sh000688', name: '科创50', role: '科技' },
  { code: 'sh000300', name: '沪深300', role: '宽基' },
  { code: 'sh000905', name: '中证500', role: '中盘' },
];

async function indexOverview() {
  const codes = INDEX_SET.map((x) => x.code);
  const res = await W.quote(codes);
  const byCode = {};
  (res.rows || []).forEach((r) => { byCode[r.code] = r; });
  const list = INDEX_SET.map((x) => {
    const r = byCode[x.code] || {};
    return {
      ...x,
      price: W.toNum(r.price), changePct: W.toNum(r.change_percent), change: W.toNum(r.change),
      amount: W.toNum(r.amount), volume: W.toNum(r.volume),
      chg5d: W.toNum(r.chg_5d), chg10d: W.toNum(r.chg_10d), chg20d: W.toNum(r.chg_20d),
      chg60d: W.toNum(r.chg_60d), chgYtd: W.toNum(r.chg_ytd),
      high52: W.toNum(r.high_52week), low52: W.toNum(r.low_52week),
      turnover: W.toNum(r.turnover_rate),
      time: cleanVal(r.time),
    };
  });
  return { updatedAt: res.fetchedAt, list };
}

async function marketBreadth() {
  const [cd, updown] = await Promise.all([
    W.changedist().catch(() => null),
    W.marketOverview('updown').catch(() => null),
  ]);
  const out = { overview: null, bins: [], sentiment: null, amount: null, amountPrev: null, updown: null };

  if (cd && cd.tables.length) {
    const t0 = cd.tables[0].rows[0] || {};
    out.overview = {
      up: W.toNum(t0['上涨']), upRatio: W.toNum(t0['上涨占比']),
      down: W.toNum(t0['下跌']), flat: W.toNum(t0['平盘']),
      halt: W.toNum(t0['停牌']), limitUp: W.toNum(t0['涨停']), limitDown: W.toNum(t0['跌停']),
    };
    const bins = cd.tables.find((t) => t.title === '涨跌幅区间分布') || cd.tables[1];
    if (bins) out.bins = bins.rows.map((r) => ({ bin: r['区间'], count: W.toNum(r['家数']), dir: r['方向'] }));
    const m = cd.text.match(/两市成交额：([\d.,]+)\s*(亿|万|万亿)?\s*（较上日\s*([-+]?[\d.,]+)\s*(亿|万|万亿)?）/);
    if (m) {
      out.amount = parseCnAmount(`${m[1]}${m[2] || ''}`);
      out.amountPrev = parseCnAmount(`${m[3]}${m[4] || ''}`);
    }
    const s = cd.text.match(/上涨家数占比全市场(\d+)%，市场情绪([^。]*)。/);
    const peak = cd.text.match(/过去一年有(\d+)%交易日处于该热度区间/);
    if (s) out.sentiment = { upRatio: Number(s[1]), label: s[2].trim(), histPercentile: peak ? Number(peak[1]) : null };
  }

  if (updown && updown.tables.length) {
    const rows = updown.tables[0].rows;
    const dict = {};
    rows.forEach((r) => { dict[String(r['指标'])] = W.toNum(r['数值']); });
    out.updown = {
      newHigh5: dict['A股创5日新高个股数'], newHigh20: dict['A股创20日新高个股数'],
      newHigh60: dict['A股创60日新高个股数'], newHigh120: dict['A股创120日新高个股数'], newHigh250: dict['A股创250日新高个股数'],
      newLow5: dict['A股创5日新低个股数'], newLow20: dict['A股创20日新低个股数'],
      newLow60: dict['A股创60日新低个股数'], newLow120: dict['A股创120日新低个股数'], newLow250: dict['A股创250日新低个股数'],
      limitUp: dict['A股涨停股票数'], limitDown: dict['A股跌停股票数'], down: dict['A股下跌股票数'],
      raw: dict,
    };
  }
  return out;
}

const PROFILE_DIM_ORDER = [
  '风格轮动', '大小盘轮动', '行业轮动', '板块宽度', '个股宽度',
  '短期趋势方向', '短期趋势强度', '中长期趋势方向', '中长期趋势强度',
  '技术指标', '情绪指标', '成交量能', '估值水平',
];

async function marketProfile() {
  const res = await W.marketOverview('profile');
  const t = res.tables[0];
  const dims = [];
  if (t) {
    t.rows.forEach((r) => {
      const name = r['维度'];
      if (!name) return;
      dims.push({ name, score: W.toNum(r['得分']), status: cleanVal(r['状态']) || '' });
    });
  }
  const rawScore = (res.text.match(/原始评分\s*\*\*([\d.]+)\*\*/) || [])[1];
  const adjScore = (res.text.match(/调整评分\s*\*\*([\d.]+)\*\*/) || [])[1];
  const dataDate = (res.text.match(/数据日期\s*`([\d-]+)`/) || [])[1] || null;
  dims.sort((a, b) => PROFILE_DIM_ORDER.indexOf(a.name) - PROFILE_DIM_ORDER.indexOf(b.name));
  const scored = dims.filter((d) => d.score !== null);
  return {
    updatedAt: res.fetchedAt, dataDate,
    rawScore: rawScore ? Number(rawScore) : null,
    adjScore: adjScore ? Number(adjScore) : null,
    dims,
    scoreAvg: A.round(A.mean(scored.map((d) => d.score)), 2),
    strongest: scored.slice().sort((a, b) => b.score - a.score).slice(0, 3),
    weakest: scored.slice().sort((a, b) => a.score - b.score).slice(0, 3),
  };
}

async function sectorBoard({ kind = 'industry', type = 'changePct', order = 'desc', limit = 20 } = {}) {
  const res = await W.sectorRanking({ kind, type, order });
  const t = res.tables[0];
  const rows = (t ? t.rows : []).slice(0, limit);
  // 板块资金 / 成交额字段上游单位为「万元」，统一换算为「元」
  const WAN = 1e4;
  const flow = (v) => { const n = W.toNum(v); return n === null ? null : n * WAN; };
  const list = rows.map((r, i) => {
    const get = (...keys) => {
      for (const k of keys) if (r[k] !== undefined) return r[k];
      return null;
    };
    return {
      rank: i + 1,
      code: cleanVal(get('code', '代码')),
      name: cleanVal(get('name', '名称', '板块名称')),
      changePct: W.toNum(get('changePct', '涨跌幅', 'change_percent')),
      mainNetInflow: flow(get('mainNetInflow')),
      mainNetInflow5d: flow(get('mainNetInflow5d')),
      mainNetInflow20d: flow(get('mainNetInflow20d')),
      turnover: flow(get('turnover', '成交额')),
      turnoverRate: W.toNum(get('turnoverRate')),
      upCount: cleanVal(get('upCount')),
      leader: cleanVal(get('leader', '领涨股', 'leaderStock')),
      raw: r,
    };
  });
  return { kind, type, order, updatedAt: res.fetchedAt, list, headers: t ? t.header : [], total: t ? t.rows.length : 0 };
}

async function hotBoard() {
  const [stocks, sectors, news] = await Promise.allSettled([
    W.hot('stock', 12), W.hot('sector', 10), W.hot('news', 10),
  ]);
  const pack = (r) => {
    if (r.status !== 'fulfilled') return [];
    const t = r.value.tables[0];
    return t ? t.rows : [];
  };
  return {
    stocks: pack(stocks).map((r, i) => ({
      rank: i + 1,
      code: cleanVal(r.code || r['代码']),
      name: cleanVal(r.name || r['名称']),
      changePct: W.toNum(r.zdf !== undefined ? r.zdf : (r.changePct !== undefined ? r.changePct : r['涨跌幅'])),
      price: W.toNum(r.zxj !== undefined ? r.zxj : (r.price !== undefined ? r.price : r['最新价'])),
      type: cleanVal(r.stock_type),
    })).filter((x) => x.name),
    sectors: pack(sectors).map((r, i) => ({
      rank: W.toNum(r.rank) || i + 1,
      rankDelta: W.toNum(r.rankdelta),
      code: cleanVal(r.symbol),
      name: cleanVal(r.name || r['名称'] || r['板块名称']),
      changePct: W.toNum(r.zdf !== undefined ? r.zdf : r.changePct),
      index: W.toNum(r.zxj !== undefined ? r.zxj : r.index),
      time: cleanVal(r.date),
    })).filter((x) => x.name),
    news: pack(news).map((r) => {
      const ts = W.toNum(r.publish_time || r.time);
      return {
        id: cleanVal(r.news_id),
        title: cleanVal(r.news_title || r.title || r['标题']),
        time: ts && ts > 1e9 ? new Date((ts + 8 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16) : cleanVal(r.publish_time),
        source: cleanVal(r.source || r['来源']),
        url: cleanVal(r.url || r['链接']),
      };
    }).filter((x) => x.title),
    updatedAt: new Date().toISOString(),
  };
}

// ---------- 市场要闻 ----------

/**
 * 要闻分类规则：按标题关键词归类，仅作**展示标签**使用，不改动原文、不做主观判断。
 * 规则自上而下匹配，命中即停（政策/国际类优先级最高，避免被普通词抢占）。
 */
const NEWS_CATEGORIES = [
  {
    key: 'policy', label: '政策宏观', tone: 'warn',
    kw: ['政策', '央行', '国务院', '发改委', '财政部', '证监会', '监管', '国常会', '降准', '降息',
      'LPR', '利率', '汇率政策', '改革', '会议', '部署', '规划', '试点', '税', '立法', '部委', '央行行长'],
  },
  {
    key: 'global', label: '国际市场', tone: 'info',
    kw: ['美股', '美联储', '纳斯达克', '道琼斯', '道指', '标普', '欧股', '日经', '港股', '恒生',
      '美元', '人民币', '原油', '黄金', '外盘', '中概', '关税', '海外', '国际', '全球', '纽约', '欧洲'],
  },
  {
    key: 'capital', label: '资金动向', tone: 'up',
    kw: ['资金', '北向', '主力', '融资', '两融', '成交额', '净流入', '净流出', '增仓', '减仓',
      '龙虎榜', 'ETF', '基金', '机构席位', '公募', '私募', '险资'],
  },
  {
    key: 'company', label: '公司公告', tone: 'primary',
    kw: ['公告', '减持', '增持', '回购', '重组', '收购', '并购', '业绩', '预增', '预亏', '分红',
      '股东', '停牌', '复牌', '退市', '上市', 'IPO', '中签', '解禁', '诉讼', '仲裁', '合同', '中标', '财报'],
  },
  {
    key: 'industry', label: '行业产业', tone: 'hot',
    kw: ['行业', '板块', '产业链', '产能', '订单', '需求', '涨价', '降价', '芯片', '半导体', '新能源',
      '储能', '光伏', '医药', '创新药', '人工智能', '算力', '机器人', '汽车', '军工', '地产', '消费', '白酒'],
  },
  {
    key: 'market', label: '市场走势', tone: 'muted',
    kw: ['指数', '涨停', '跌停', '涨幅', '跌幅', 'A股', '沪深', '沪指', '创业板', '科创', '行情',
      '异动', '翻倍', '反弹', '回调', '震荡', '新高', '新低', '成交', '开盘', '收盘', '盘面', '晚报', '早报'],
  },
];
const NEWS_OTHER = { key: 'other', label: '其他', tone: 'muted' };

/** 按标题关键词归类（命中即停） */
function classifyNews(title) {
  const t = String(title || '');
  for (const c of NEWS_CATEGORIES) {
    if (c.kw.some((k) => t.includes(k))) return { key: c.key, label: c.label, tone: c.tone };
  }
  return { ...NEWS_OTHER };
}

/** 北京时间的「今天」日期字符串（不依赖服务器时区） */
function bjtToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** unix 秒 → 北京时间 'YYYY-MM-DD HH:mm' */
function bjtTime(ts) {
  const n = W.toNum(ts);
  if (n === null || n < 1e9) return null;
  return new Date((n + 8 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

/** 日期 → 分组标签：今日 / 昨日 / M月D日 */
function dayLabel(date, today) {
  if (!date) return '更早';
  if (date === today) return '今日';
  const y = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (date === y) return '昨日';
  const [, m, d] = date.split('-');
  return `${Number(m)} 月 ${Number(d)} 日`;
}

/**
 * 市场要闻模块
 * 数据来源：热文榜单（自带热度排名）+ 资讯详情（提取摘要）。
 * bypass=true 时跳过缓存回源，用于「刷新要闻」保证时效。
 */
async function marketNews({ limit = 40, detailTop = 10, bypass = false } = {}) {
  const res = await W.hotNews(limit, { bypass });
  const rows = (res.tables && res.tables[0] ? res.tables[0].rows : []) || [];
  const today = bjtToday();

  const list = rows.map((r, i) => {
    const id = cleanVal(r.news_id || r.id);
    const title = cleanVal(r.news_title || r.title);
    const time = bjtTime(r.publish_time || r.time);
    return {
      id,
      rank: W.toNum(r.rank) || i + 1,
      title,
      time,
      date: time ? time.slice(0, 10) : null,
      dayLabel: dayLabel(time ? time.slice(0, 10) : null, today),
      source: cleanVal(r.source) || '未知来源',
      url: cleanVal(r.url),
      hasVideo: String(cleanVal(r.has_video) || '0') === '1',
      category: classifyNews(title),
      summary: null,
      summaryFrom: null,
    };
  }).filter((x) => x.title);

  // 热度前 detailTop 条补摘要（详情接口），其余标注未取正文
  const targets = list.slice(0, Math.max(0, detailTop));
  const details = await Promise.allSettled(targets.map((x) => W.newsDetail(`nes${x.id}`)));
  details.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    const s = extractSummary(r.value.text, 130);
    if (s) { targets[i].summary = s; targets[i].summaryFrom = '资讯正文'; }
  });

  // 分类分布（用于筛选标签上的计数）
  const byCategory = {};
  list.forEach((x) => { byCategory[x.category.key] = (byCategory[x.category.key] || 0) + 1; });

  const catList = NEWS_CATEGORIES
    .map((c) => ({ key: c.key, label: c.label, tone: c.tone, count: byCategory[c.key] || 0 }))
    .concat([{ key: 'other', label: NEWS_OTHER.label, tone: NEWS_OTHER.tone, count: byCategory.other || 0 }])
    .filter((c) => c.count > 0);

  return {
    total: list.length,
    withSummary: list.filter((x) => x.summary).length,
    todayCount: list.filter((x) => x.dayLabel === '今日').length,
    latestTime: list.reduce((mx, x) => (x.time && (!mx || x.time > mx) ? x.time : mx), null),
    updatedAt: new Date().toISOString(),
    fetchedAt: res.fetchedAt,
    cached: !!res.cached,
    categories: catList,
    list,
    source: '腾讯自选股数据接口（热文榜）',
    note: '要闻按数据源热度榜排名展示，分类标签由标题关键词自动生成；摘要取自资讯正文首段，仅对热度靠前的若干条提取。',
  };
}

// ---------- 资金流向 / 技术扫描（按需传码） ----------

async function fundFlowBoard(codes) {
  const list = [...new Set((codes || []).filter(Boolean))];
  if (!list.length) return { list: [], updatedAt: new Date().toISOString() };
  const res = await W.fundFlow(list);
  const t = res.tables[0];
  const rows = t ? t.rows : [];
  return {
    updatedAt: res.fetchedAt,
    headers: t ? t.header : [],
    list: rows.map((r) => {
      const pick = (...keys) => { for (const k of keys) if (r[k] !== undefined) return r[k]; return null; };
      return {
        code: cleanVal(pick('code', '代码')), name: cleanVal(pick('name', '名称')),
        mainNetInflow: W.toNum(pick('mainNetInflow', '主力净流入')),
        mainInflow: W.toNum(pick('mainInflow', '主力流入')),
        mainOutflow: W.toNum(pick('mainOutflow', '主力流出')),
        retailNetInflow: W.toNum(pick('retailNetInflow', '散户净流入')),
        changePct: W.toNum(pick('changePct', '涨跌幅')),
        raw: r,
      };
    }),
  };
}

/** 对一组标的做技术分析 */
async function technicalScan(codes, { limit = 60 } = {}) {
  const list = [...new Set((codes || []).filter(Boolean))];
  if (!list.length) return { items: [], updatedAt: new Date().toISOString() };
  const results = await Promise.allSettled(list.map(async (code) => {
    const [k, q] = await Promise.all([W.kline(code, 'day', limit), W.quote(code).catch(() => null)]);
    const bars = (k.rows || []).map((r) => ({
      date: r.date, open: r.open, last: r.last, high: r.high, low: r.low,
      volume: r.volume, amount: r.amount, change_pct: r.change_pct,
    }));
    const analysis = A.analyzeSeries(bars);
    const row = q && q.rows && q.rows[0] ? q.rows[0] : {};
    return {
      code,
      name: cleanVal(row.name) || code,
      market: cleanVal(row.market_name),
      price: W.toNum(row.price),
      changePct: W.toNum(row.change_percent),
      pe: W.toNum(row.pe_ratio), pb: W.toNum(row.pb_ratio),
      marketCap: A.normCap(row.total_market_cap),
      turnoverRate: W.toNum(row.turnover_rate),
      bars, analysis,
    };
  }));
  const items = results.map((r, i) => (r.status === 'fulfilled' ? r.value
    : { code: list[i], name: list[i], error: String(r.reason && r.reason.message || r.reason), analysis: { ok: false }, bars: [] }));
  return { updatedAt: new Date().toISOString(), items, summary: A.compareSeries(
    Object.fromEntries(items.filter((x) => x.analysis && x.analysis.ok).map((x) => [x.code, { ...x.analysis, name: x.name }]))
  ) };
}

/** 生成市场分析报告（结构化，供前端与推送使用） */
async function buildMarketReport() {
  const [idx, breadth, profile, secUp, secFlow, secDown, hot] = await Promise.all([
    indexOverview().catch(() => ({ list: [] })),
    marketBreadth().catch(() => ({})),
    marketProfile().catch(() => ({ dims: [] })),
    sectorBoard({ kind: 'industry', type: 'changePct', order: 'desc', limit: 10 }).catch(() => ({ list: [] })),
    sectorBoard({ kind: 'industry', type: 'mainNetInflow', order: 'desc', limit: 10 }).catch(() => ({ list: [] })),
    sectorBoard({ kind: 'industry', type: 'changePct', order: 'asc', limit: 8 }).catch(() => ({ list: [] })),
    hotBoard().catch(() => ({ stocks: [], sectors: [], news: [] })),
  ]);

  const ov = breadth.overview || {};
  const pros = [], cons = [];
  if (ov.upRatio !== null && ov.upRatio >= 60) pros.push(`全市场上涨家数占比 ${ov.upRatio}%，赚钱效应扩散`);
  if (ov.upRatio !== null && ov.upRatio <= 40) cons.push(`全市场上涨家数占比仅 ${ov.upRatio}%，赚钱效应偏弱`);
  if (ov.limitUp !== null && ov.limitUp >= 50) pros.push(`涨停 ${ov.limitUp} 家，短线资金活跃`);
  if (ov.limitDown !== null && ov.limitDown >= 20) cons.push(`跌停 ${ov.limitDown} 家，需警惕个股风险释放`);
  const ud = breadth.updown || {};
  if (ud.newHigh20 !== null && ud.newHigh20 > 400) pros.push(`20 日新高个股 ${ud.newHigh20} 只，广度改善`);
  if (ud.newLow20 !== null && ud.newLow20 > 300) cons.push(`20 日新低个股 ${ud.newLow20} 只，破位压力存在`);

  const dims = profile.dims || [];
  const strongDims = dims.filter((d) => d.score !== null && d.score >= 4);
  const weakDims = dims.filter((d) => d.score !== null && d.score <= 2);
  strongDims.slice(0, 3).forEach((d) => pros.push(`${d.name}：${d.status}`));
  weakDims.slice(0, 3).forEach((d) => cons.push(`${d.name}：${d.status}`));

  const idxText = (idx.list || []).slice(0, 4).map((x) => `${x.name} ${x.price}（${x.changePct >= 0 ? '+' : ''}${x.changePct}%）`).join('，');

  const totalScore = profile.adjScore !== null ? profile.adjScore
    : (profile.scoreAvg !== null ? A.round(profile.scoreAvg / 5 * 100, 1) : null);
  let regime = '震荡';
  if (totalScore !== null) regime = totalScore >= 65 ? '偏强市（进攻）' : totalScore >= 50 ? '中性偏强' : totalScore >= 35 ? '中性震荡' : '偏弱市（防守）';

  const strategy = [];
  if (totalScore !== null && totalScore >= 50) {
    strategy.push('仓位建议 6~7 成，向资金持续流入且趋势向上的行业倾斜');
    strategy.push('优选均线多头排列、放量突破的强势标的，回调至 MA20 附近分批介入');
  } else if (totalScore !== null && totalScore >= 35) {
    strategy.push('仓位建议 4~5 成，以结构性机会为主，控制单一行业暴露');
    strategy.push('关注新高中个股的持续性，快进快出，严格止损');
  } else {
    strategy.push('仓位建议 2~3 成，以防守为主，保留现金等待右侧信号');
    strategy.push('回避破位下跌与业绩不及预期标的，优先高股息低波资产');
  }
  if (weakDims.some((d) => d.name.includes('估值')) ) strategy.push('估值分位偏高，注意高估值板块的均值回归风险');
  strategy.push('单笔止损建议不超过 -8%，组合回撤超过 -10% 时主动降低仓位');

  return {
    generatedAt: new Date().toISOString(),
    dataDate: profile.dataDate || (idx.list[0] && idx.list[0].time) || TODAY(),
    regime,
    totalScore,
    indexText: idxText,
    indices: idx.list,
    breadth: { overview: ov, bins: breadth.bins || [], updown: ud, amount: breadth.amount, amountPrev: breadth.amountPrev, sentiment: breadth.sentiment },
    profile,
    sectors: { top: secUp.list || [], flow: secFlow.list || [], bottom: secDown.list || [] },
    hot,
    pros: [...new Set(pros)].slice(0, 8),
    cons: [...new Set(cons)].slice(0, 8),
    strategy,
    source: '腾讯自选股数据接口 / NeoData',
    disclaimer: '本报告由 AI 基于公开市场数据自动生成，仅供研究参考，不构成任何投资建议。市场有风险，决策需谨慎。',
  };
}

// ============================================================
// 推送扫描引擎
// ============================================================

async function scanNotifications(store) {
  const subs = store.subscriptions.filter((s) => s.enabled);
  const has = (t) => subs.some((s) => s.type === t);
  const items = [];
  const today = TODAY();

  // 1. 新股发行
  if (has('ipo') || has('ipo_calendar')) {
    const markets = ['hs', 'hk'].filter((m) => subs.some((s) => (s.type === 'ipo' || s.type === 'ipo_calendar') && (!s.market || s.market === m)));
    const data = await ipoAllMarkets(markets.length ? markets : ['hs']).catch(() => ({}));
    Object.values(data).forEach((mod) => {
      (mod.list || []).forEach((x) => {
        if (x.stageKey === 'subscribing') {
          items.push({
            type: 'ipo', level: 'high', category: '新股消息',
            title: `${x.name}（${x.code}）今日申购`,
            body: `${x.marketLabel}新股 ${x.name} 正在申购${x.priceText ? `，发行价区间 ${x.priceText}` : ''}。${x.subscribeEnd ? `申购截止 ${x.subscribeEnd}` : ''}`,
            meta: { code: x.code, market: x.market, stage: x.stage },
            fingerprint: `ipo-sub|${x.market}|${x.code}|${x.subscribeStart}`,
          });
        } else if (x.stageKey === 'prelist' || (x.daysToListing !== null && x.daysToListing >= 0 && x.daysToListing <= 1)) {
          items.push({
            type: 'ipo', level: 'high', category: '新股消息',
            title: `${x.name}（${x.code}）${x.daysToListing === 0 ? '今日上市' : '即将上市'}`,
            body: `${x.marketLabel}新股 ${x.name} 上市日为 ${x.listingDate}${x.priceMid ? `，发行价 ${x.priceMid}` : ''}。`,
            meta: { code: x.code, market: x.market, listingDate: x.listingDate },
            fingerprint: `ipo-list|${x.market}|${x.code}|${x.listingDate}`,
          });
        } else if (x.daysToSubscribe !== null && x.daysToSubscribe > 0 && x.daysToSubscribe <= 3) {
          items.push({
            type: 'ipo', level: 'normal', category: '新股消息',
            title: `${x.name}（${x.code}）将于 ${x.subscribeStart} 开启申购`,
            body: `距申购日还有 ${x.daysToSubscribe} 天，可提前准备打新额度。`,
            meta: { code: x.code, market: x.market },
            fingerprint: `ipo-pending|${x.market}|${x.code}|${x.subscribeStart}`,
          });
        }
      });
    });
  }

  // 2. 指数大幅波动
  if (subs.some((s) => s.type === 'index_move')) {
    const thr = (subs.find((s) => s.type === 'index_move').threshold) || 1;
    const idx = await indexOverview().catch(() => ({ list: [] }));
    idx.list.forEach((x) => {
      if (x.changePct !== null && Math.abs(x.changePct) >= thr) {
        items.push({
          type: 'index_move', level: Math.abs(x.changePct) >= 2 ? 'high' : 'normal', category: '市场异动',
          title: `${x.name} ${x.changePct >= 0 ? '上涨' : '下跌'} ${Math.abs(x.changePct)}%，现报 ${x.price}`,
          body: `指数波动超过 ${thr}% 阈值。当日成交额 ${fmtCnAmount(x.amount)}，5 日累计 ${x.chg5d}%，20 日累计 ${x.chg20d}%。`,
          meta: { code: x.code, changePct: x.changePct },
          fingerprint: `idx|${x.code}|${x.time}|${x.changePct}`,
        });
      }
    });
  }

  // 3. 自选股异动
  const watchSub = subs.find((s) => s.type === 'watchlist_move');
  if (watchSub && store.watchlist.length) {
    const thr = watchSub.threshold || 5;
    const tech = await technicalScan(store.watchlist, { limit: 60 }).catch(() => ({ items: [] }));
    tech.items.forEach((x) => {
      if (x.changePct !== null && Math.abs(x.changePct) >= thr) {
        items.push({
          type: 'watchlist_move', level: 'high', category: '自选异动',
          title: `${x.name}（${x.code}）${x.changePct >= 0 ? '大涨' : '大跌'} ${Math.abs(x.changePct)}%`,
          body: `现价 ${x.price}，换手率 ${x.turnoverRate}%，技术面评分 ${x.analysis && x.analysis.score}（${x.analysis && x.analysis.verdict}）。`,
          meta: { code: x.code, changePct: x.changePct },
          fingerprint: `watch|${x.code}|${x.changePct}`,
        });
      }
    });
  }

  // 4. 财报披露
  if (subs.some((s) => s.type === 'financial_report')) {
    const cal = await reportCalendar('hs', 40).catch(() => ({ list: [] }));
    cal.list.forEach((x) => {
      if (x.daysLeft !== null && x.daysLeft >= 0 && x.daysLeft <= 2) {
        items.push({
          type: 'financial_report', level: 'normal', category: '财报提醒',
          title: `${x.name}（${x.code}）将于 ${x.date} 披露财报`,
          body: x.daysLeft === 0 ? '今日为预约披露日，关注业绩兑现情况。' : `距披露日还有 ${x.daysLeft} 天，可提前布局或规避。`,
          meta: { code: x.code, date: x.date },
          fingerprint: `report|${x.code}|${x.date}`,
        });
      }
    });
  }

  const fresh = store.pushNotifications(items);
  store.recordScan();
  return { scanned: items.length, created: fresh.length, items: fresh };
}

module.exports = {
  // 工具
  splitDateRange, splitPriceRange, parseCnAmount, fmtCnAmount, daysBetween, quarterLabel, cleanVal,
  // 模块一
  ipoModule, ipoAllMarkets,
  // 模块四
  ipoNewsModule, extractSummary, stockNews, normalizeNewsCode,
  // 新股上市表现（暴涨 / 破发）
  analyzeIpoPerformance, attachIpoPerf, perfStats, perfPct, perfJudge, perfMerge, IPO_PERF,
  // 模块二
  companyFinance, compareFinance, reportCalendar, normalizeCompany, companyBusiness,
  // 模块三
  indexOverview, marketBreadth, marketProfile, sectorBoard, hotBoard, marketNews, fundFlowBoard,
  technicalScan, buildMarketReport,
  // 推送
  scanNotifications,
  INDEX_SET,
};
