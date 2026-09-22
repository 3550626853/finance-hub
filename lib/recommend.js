'use strict';
/**
 * recommend.js — 推荐榜单模块
 * 基于全市场排行选股（westock screen ranking）构建多维度榜单，
 * 并为每只入选股票生成**可溯源**的推荐理由（全部来自真实字段，不做主观臆断）。
 */

const W = require('./westock');
const A = require('./analytics');

const BOARDS = [
  {
    id: 'comp', label: '精选综合榜', type: 'CompScore', asc: false,
    rankNoun: '综合评分',
    tagline: '全市场综合评分最高',
    desc: '综合评分同时纳入基本面、技术面、资金面与风险控制，是覆盖面最广的筛选口径。',
    accent: '#2563eb',
    metrics: ['CompScore', 'FunmScore', 'TecScore', 'CapScore', 'RiskScore'],
    sortMetric: 'CompScore',
  },
  {
    id: 'fundamental', label: '基本面优等榜', type: 'FunmScore', asc: false,
    rankNoun: '基本面评分',
    tagline: '基本面评分领先',
    desc: '以盈利能力、财务质量、成长性为主的评分口径，适合偏好价值与业绩驱动的投资者。',
    accent: '#0f9d58',
    // 排序依据指标排在首位，便于阅读与核对
    metrics: ['FunmScore', 'CompScore', 'TecScore', 'CapScore', 'RiskScore'],
    sortMetric: 'FunmScore',
  },
  {
    id: 'risk', label: '风控稳健榜', type: 'RiskScore', asc: false,
    rankNoun: '风险评分',
    tagline: '风险控制评分领先',
    desc: '数据源风险评分口径，分数越高代表波动控制、财务稳健度与回撤管理越好；适合以控制回撤为优先目标的投资者。',
    accent: '#0d9488',
    metrics: ['RiskScore', 'CompScore', 'FunmScore', 'TecScore', 'CapScore'],
    sortMetric: 'RiskScore',
  },
  {
    id: 'technical', label: '技术强势榜', type: 'TecScore', asc: false,
    rankNoun: '技术评分',
    tagline: '技术面结构强势',
    desc: '以趋势、动量、量价结构为主的评分口径，适合偏交易型、注重节奏的投资者。',
    accent: '#d92b2b',
    metrics: ['TecScore', 'CompScore', 'FunmScore', 'CapScore', 'RiskScore'],
    sortMetric: 'TecScore',
  },
  {
    id: 'capital', label: '资金青睐榜', type: 'CapScore', asc: false,
    rankNoun: '资金评分',
    tagline: '主力资金关注度高',
    desc: '以资金流向、成交结构为主的评分口径，反映主力资金的参与意愿。',
    accent: '#7c3aed',
    metrics: ['CapScore', 'CompScore', 'FunmScore', 'TecScore', 'RiskScore'],
    sortMetric: 'CapScore',
  },
  {
    id: 'mainnet', label: '主力净流入榜', type: 'cap_main_net', asc: false,
    rankNoun: '当日主力净流入额',
    tagline: '当日主力资金净流入居前',
    desc: '按当日主力资金（大单 + 超大单）净流入金额排序，反映当日资金的真实买入强度；单日金额受行情影响较大，宜结合连续性一起看。',
    accent: '#e11d48',
    metrics: ['MainNetIn'],
    sortMetric: 'MainNetIn',
  },
  {
    id: 'inflow', label: '资金持续流入榜', type: 'cap_in_days', asc: false,
    rankNoun: '连续净流入天数',
    tagline: '主力连续多日净流入',
    desc: '按主力资金连续净流入天数排序。持续流入通常代表资金在区间内反复增持，比单日脉冲更能反映资金意愿。',
    accent: '#9333ea',
    metrics: ['MainInDays', 'MainOutDays'],
    sortMetric: 'MainInDays',
  },
  {
    id: 'north', label: '北向活跃榜', type: 'north_appear_m', asc: false,
    rankNoun: '月内上榜次数',
    universeLabel: '近半年北向成交活跃榜样本',
    tagline: '北向成交活跃度居前',
    desc: '统计近半年「北向成交活跃股」的月度上榜次数，反映外资参与程度。为月度统计口径，不代表实时持仓或净买入方向。',
    accent: '#0891b2',
    metrics: ['NorthAppearM', 'NorthAppearRatio'],
    sortMetric: 'NorthAppearM',
  },
  {
    id: 'growth', label: '成长能力榜', type: 'fin_growth', asc: false,
    rankNoun: '成长能力',
    tagline: '营收与利润增速领先',
    desc: '按财务成长性指标排序，关注收入与利润的扩张速度。',
    accent: '#0ea5e9',
    metrics: ['RevenueGrowth', 'NetProfitGrowth', 'OperatingProfitGrowth', 'AssetGrowth'],
    sortMetric: 'RevenueGrowth',
  },
  {
    id: 'cashflow', label: '现金流规模榜', type: 'fin_cash_size', asc: false,
    rankNoun: '经营现金流(TTM)',
    tagline: '经营现金流(TTM)规模居前',
    desc: '按经营活动现金流净额(TTM)排序，衡量主营业务造血能力。金融行业现金流体量天然较大，榜首以银行、保险为主，跨行业比较时需注意可比性。',
    accent: '#16a34a',
    metrics: ['CFOTTM', 'NetCashflowTTM'],
    sortMetric: 'CFOTTM',
  },
  {
    id: 'pershare', label: '每股指标榜', type: 'fin_pershare', asc: false,
    rankNoun: '每股收益(TTM)',
    tagline: '每股收益(TTM)居前',
    desc: '按每股收益(TTM)排序，直观反映单位股本的盈利水平。高 EPS 往往对应高价股，需结合股本、估值与每股现金流一并判断。',
    accent: '#ca8a04',
    metrics: ['EpsTTM', 'OrpsTTM', 'CFOpsTTM'],
    sortMetric: 'EpsTTM',
  },
  {
    id: 'value', label: '低估值高股息榜', type: 'fin_valuation', asc: true,
    extra: ['--min-PE_TTM', '5', '--min-DIV_TTM', '2'],
    rankNoun: '估值（由低到高）',
    tagline: 'PE 与股息率双重筛选',
    desc: '在 PE(TTM) ≥ 5 且股息率 ≥ 2% 的样本中，按估值从低到高排序，剔除极端异常值。',
    accent: '#d97706',
    metrics: ['PE_TTM', 'DIV_TTM', 'PB_LF', 'PS_TTM', 'PCF_TTM'],
    sortMetric: 'PE_TTM',
  },
];

/** 排行表列名（中文）→ 内部键名 */
const METRIC_ALIAS = {
  '综合评分': 'CompScore', '资金评分': 'CapScore', '基本面评分': 'FunmScore',
  '风险评分': 'RiskScore', '技术评分': 'TecScore',
  上榜次数: 'NorthAppearM', '上榜比例(%)': 'NorthAppearRatio', '上榜比例': 'NorthAppearRatio',
  PE_TTM: 'PE_TTM', DIV_TTM: 'DIV_TTM', PB_LF: 'PB_LF', PCF_TTM: 'PCF_TTM', PS_TTM: 'PS_TTM',
  RevenueGrowth: 'RevenueGrowth', AssetGrowth: 'AssetGrowth',
  NetProfitGrowth: 'NetProfitGrowth', OperatingProfitGrowth: 'OperatingProfitGrowth',
  MainNetIn: 'MainNetIn', MainInDays: 'MainInDays', MainOutDays: 'MainOutDays',
  CFOTTM: 'CFOTTM', NetCashflowTTM: 'NetCashflowTTM',
  EpsTTM: 'EpsTTM', OrpsTTM: 'OrpsTTM', CFOpsTTM: 'CFOpsTTM',
};

/**
 * 指标展示元数据（标签 + 单位 + 是否越高越好）
 * money=true 表示原始单位为「万元」，展示时统一换算为「亿元」（数据源实测口径）。
 */
const METRIC_DISPLAY = {
  CompScore: { label: '综合评分', unit: '分', higherBetter: true },
  FunmScore: { label: '基本面评分', unit: '分', higherBetter: true },
  TecScore: { label: '技术评分', unit: '分', higherBetter: true },
  CapScore: { label: '资金评分', unit: '分', higherBetter: true },
  RiskScore: { label: '风险评分', unit: '分', higherBetter: true },
  RevenueGrowth: { label: '营收同比', unit: '%', higherBetter: true },
  NetProfitGrowth: { label: '净利同比', unit: '%', higherBetter: true },
  OperatingProfitGrowth: { label: '营业利润同比', unit: '%', higherBetter: true },
  AssetGrowth: { label: '总资产同比', unit: '%', higherBetter: true },
  PE_TTM: { label: 'PE(TTM)', unit: '倍', higherBetter: false },
  DIV_TTM: { label: '股息率(TTM)', unit: '%', higherBetter: true },
  PB_LF: { label: 'PB(LF)', unit: '倍', higherBetter: false },
  PS_TTM: { label: 'PS(TTM)', unit: '倍', higherBetter: false },
  PCF_TTM: { label: 'PCF(TTM)', unit: '倍', higherBetter: false },
  MainNetIn: { label: '主力净流入', unit: '万元', higherBetter: true, money: true },
  MainInDays: { label: '连续净流入', unit: '天', higherBetter: true },
  MainOutDays: { label: '连续净流出', unit: '天', higherBetter: false },
  NorthAppearM: { label: '月内上榜次数', unit: '次', higherBetter: true },
  NorthAppearRatio: { label: '上榜比例', unit: '%', higherBetter: true },
  CFOTTM: { label: '经营现金流(TTM)', unit: '万元', higherBetter: true, money: true },
  NetCashflowTTM: { label: '现金净增加额(TTM)', unit: '万元', higherBetter: true, money: true },
  EpsTTM: { label: '每股收益(TTM)', unit: '元', higherBetter: true },
  OrpsTTM: { label: '每股营收(TTM)', unit: '元', higherBetter: true },
  CFOpsTTM: { label: '每股经营现金流(TTM)', unit: '元', higherBetter: true },
};

const BOARD_MAP = Object.fromEntries(BOARDS.map((b) => [b.id, b]));

/** 每个榜单默认展示的股票数量 */
const SHOW_LIMIT = 50;

const clean = (v) => (v === '--' || v === '-' || v === '' ? null : v);

/** 0-100 分值的定性描述 */
function grade(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 90) return '优秀';
  if (v >= 80) return '优良';
  if (v >= 70) return '良好';
  if (v >= 60) return '中性偏上';
  if (v >= 50) return '中性';
  if (v >= 40) return '偏弱';
  return '较弱';
}

const pctStr = (v, d = 2) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`);

/** 万元 → 亿元（数据源资金/现金流类字段实测单位为万元） */
const yiStr = (wan, sign = false) => {
  const v = Number(wan);
  if (!Number.isFinite(v)) return '—';
  const y = v / 1e4;
  return `${sign && y > 0 ? '+' : ''}${y.toFixed(2)} 亿元`;
};

/**
 * 逐条生成推荐理由。每条都对应一个真实字段，便于用户自行复核。
 */
function buildReasons(stock, board, ctx) {
  const reasons = [];
  const risks = [];
  const { rank, total, metrics, tech, quote } = stock;

  // 1) 榜单定位
  if (rank && total) {
    const pct = A.round((rank / total) * 100, 2);
    const scope = board.universeLabel
      ? `${board.universeLabel}（共 ${total.toLocaleString('zh-CN')} 只）`
      : (board.extra && board.extra.length
        ? `筛选后的 ${total.toLocaleString('zh-CN')} 只样本`
        : `全部 ${total.toLocaleString('zh-CN')} 只 A 股`);
    reasons.push(`在${scope}中，${board.rankNoun}位列第 ${rank} 名（前 ${pct}%）`);
  }

  // 2) 评分维度
  const m = metrics || {};
  if (m.CompScore !== null && m.CompScore !== undefined) reasons.push(`综合评分 ${m.CompScore} 分（${grade(m.CompScore)}）`);
  if (m.FunmScore !== null && m.FunmScore !== undefined) reasons.push(`基本面评分 ${m.FunmScore} 分（${grade(m.FunmScore)}），盈利与财务质量突出`);
  if (m.TecScore !== null && m.TecScore !== undefined) reasons.push(`技术评分 ${m.TecScore} 分（${grade(m.TecScore)}），趋势与量价结构占优`);
  if (m.CapScore !== null && m.CapScore !== undefined) reasons.push(`资金评分 ${m.CapScore} 分（${grade(m.CapScore)}），主力资金参与意愿较强`);

  // 3) 成长性（成长榜字段）
  if (m.RevenueGrowth !== undefined && m.RevenueGrowth !== null) {
    reasons.push(`营业收入同比 ${pctStr(m.RevenueGrowth)}，收入规模快速扩张`);
  }
  if (m.NetProfitGrowth !== undefined && m.NetProfitGrowth !== null) {
    reasons.push(`归母净利润同比 ${pctStr(m.NetProfitGrowth)}，盈利同步释放`);
  }
  if (m.OperatingProfitGrowth !== undefined && m.OperatingProfitGrowth !== null && m.NetProfitGrowth === null) {
    reasons.push(`营业利润同比 ${pctStr(m.OperatingProfitGrowth)}`);
  }

  // 4) 估值（估值榜字段）
  if (m.PE_TTM !== undefined && m.PE_TTM !== null) {
    reasons.push(`PE(TTM) 仅 ${A.round(m.PE_TTM, 2)} 倍，估值处于低位区间`);
  }
  if (m.DIV_TTM !== undefined && m.DIV_TTM !== null && m.DIV_TTM > 0) {
    reasons.push(`股息率(TTM) ${A.round(m.DIV_TTM, 2)}%，具备现金分红回报`);
  }
  if (m.PB_LF !== undefined && m.PB_LF !== null) {
    reasons.push(`PB(LF) ${A.round(m.PB_LF, 2)} 倍`);
  }

  // 5) 资金流（主力净流入 / 连续流入天数，单位：万元）
  if (m.MainNetIn !== undefined && m.MainNetIn !== null) {
    reasons.push(`当日主力资金（大单 + 超大单）净流入 ${yiStr(m.MainNetIn, true)}`);
  }
  if (m.MainInDays !== undefined && m.MainInDays !== null && m.MainInDays > 0) {
    reasons.push(`主力资金已连续 ${m.MainInDays} 个交易日净流入，参与具备连续性`);
  }
  if (m.MainOutDays !== undefined && m.MainOutDays !== null && m.MainOutDays > 0) {
    risks.push(`主力资金连续 ${m.MainOutDays} 个交易日净流出，短期资金面承压`);
  }

  // 6) 北向活跃度（月度上榜口径）
  if (m.NorthAppearM !== undefined && m.NorthAppearM !== null) {
    const ratio = m.NorthAppearRatio === undefined || m.NorthAppearRatio === null
      ? '' : `（上榜比例 ${A.round(m.NorthAppearRatio, 1)}%）`;
    reasons.push(`近半年「北向成交活跃股」月度上榜 ${m.NorthAppearM} 次${ratio}，外资参与度居前`);
  }

  // 7) 现金流规模（TTM，单位：万元）
  if (m.CFOTTM !== undefined && m.CFOTTM !== null) {
    if (m.CFOTTM > 0) reasons.push(`经营活动现金流(TTM) ${yiStr(m.CFOTTM)}，主业造血能力强`);
    else risks.push(`经营活动现金流(TTM) 为负（${yiStr(m.CFOTTM)}），现金流状况需重点关注`);
  }
  if (m.NetCashflowTTM !== undefined && m.NetCashflowTTM !== null && m.NetCashflowTTM > 0) {
    reasons.push(`现金及等价物净增加额(TTM) ${yiStr(m.NetCashflowTTM)}，账面现金规模扩张`);
  }

  // 8) 每股指标（TTM）
  if (m.EpsTTM !== undefined && m.EpsTTM !== null) {
    reasons.push(`每股收益(TTM) ${A.round(m.EpsTTM, 2)} 元，单位股本盈利水平居前`);
  }
  if (m.OrpsTTM !== undefined && m.OrpsTTM !== null) {
    reasons.push(`每股营业收入(TTM) ${A.round(m.OrpsTTM, 2)} 元`);
  }
  if (m.CFOpsTTM !== undefined && m.CFOpsTTM !== null) {
    if (m.CFOpsTTM > 0) reasons.push(`每股经营现金流(TTM) ${A.round(m.CFOpsTTM, 2)} 元，利润现金含量良好`);
    else risks.push(`每股经营现金流(TTM) 为负（${A.round(m.CFOpsTTM, 2)} 元），盈利现金含量需关注`);
  }

  // 9) 技术结构（来自 technical 指标）
  if (tech) {
    const ma5 = tech.MA_5, ma20 = tech.MA_20, ma60 = tech.MA_60, close = tech.closePrice;
    if (ma5 !== null && ma20 !== null && ma60 !== null) {
      if (ma5 > ma20 && ma20 > ma60) reasons.push(`均线多头排列（MA5 ${A.round(ma5, 2)} > MA20 ${A.round(ma20, 2)} > MA60 ${A.round(ma60, 2)}），中期趋势向上`);
      else if (ma5 < ma20 && ma20 < ma60) risks.push(`均线空头排列（MA5 ${A.round(ma5, 2)} < MA20 ${A.round(ma20, 2)} < MA60 ${A.round(ma60, 2)}），趋势尚未转强`);
    }
    if (close !== null && ma20 !== null && ma20 !== 0) {
      const dev = A.round(((close - ma20) / ma20) * 100, 2);
      if (dev > 0) reasons.push(`现价 ${A.round(close, 2)} 站上 20 日均线（偏离 ${pctStr(dev)}）`);
      else risks.push(`现价 ${A.round(close, 2)} 位于 20 日均线下方（偏离 ${pctStr(dev)}）`);
    }
    if (tech.MACD !== null && tech.MACD !== undefined) {
      const dir = tech.MACD > 0 ? '红柱' : '绿柱';
      reasons.push(`MACD ${dir} ${A.round(tech.MACD, 3)}${tech.DIF !== null && tech.DEA !== null ? `，DIF ${A.round(tech.DIF, 3)} / DEA ${A.round(tech.DEA, 3)}` : ''}`);
    }
    if (tech.RSI_6 !== null && tech.RSI_6 !== undefined) {
      const r = tech.RSI_6;
      if (r >= 80) risks.push(`RSI6 ${A.round(r, 1)} 已进入超买区，短线存在回调压力`);
      else if (r >= 60) reasons.push(`RSI6 ${A.round(r, 1)}，短线动能偏强`);
      else if (r <= 25) reasons.push(`RSI6 ${A.round(r, 1)} 处于超卖区，存在超跌反弹动能`);
      else risks.push(`RSI6 ${A.round(r, 1)}，短线动能中性`);
    }
    if (tech.BOLL_UPPER !== null && tech.BOLL_LOWER !== null && close !== null && tech.BOLL_UPPER !== tech.BOLL_LOWER) {
      const pos = A.round(((close - tech.BOLL_LOWER) / (tech.BOLL_UPPER - tech.BOLL_LOWER)) * 100, 0);
      if (pos > 100) risks.push(`股价已突破布林上轨（轨道位置 ${pos}%），短期波动加剧，追高需谨慎`);
      else if (pos >= 88) risks.push(`股价贴近布林上轨（轨道位置 ${pos}%），短期波动加剧`);
      else if (pos <= 15) reasons.push(`股价接近布林下轨（轨道位置 ${pos}%），向下空间相对有限`);
    }
  }

  // 10) 风险维度
  if (m.RiskScore !== null && m.RiskScore !== undefined) {
    if (m.RiskScore >= 75) reasons.push(`风险评分 ${m.RiskScore} 分，风险控制表现较好`);
    else if (m.RiskScore < 60) risks.push(`风险评分仅 ${m.RiskScore} 分，需留意股价波动与基本面不确定性`);
  }
  if (quote && quote.pe !== null && quote.pe !== undefined && quote.pe > 100 && m.PE_TTM === undefined) {
    risks.push(`PE(TTM) ${A.round(quote.pe, 1)} 倍，估值处于高位`);
  }

  return { reasons: reasons.slice(0, 6), risks: risks.slice(0, 3) };
}

/** 抽取排行响应里的元信息（总数 / 数据日期 / 排序方向） */
function parseRankMeta(text) {
  const total = (text.match(/共\s*([\d,]+)\s*只/) || [])[1];
  const date = (text.match(/\((\d{4}-\d{2}-\d{2})\)/) || [])[1] || null;
  const shown = (text.match(/显示\s*([\d-]+)\/([\d,]+)/) || [])[2];
  return {
    total: total ? Number(total.replace(/,/g, '')) : (shown ? Number(shown.replace(/,/g, '')) : null),
    date,
  };
}

/** 榜单目录（不含重数据） */
function boardCatalog() {
  return {
    updatedAt: new Date().toISOString(),
    boards: BOARDS.map((b) => ({ id: b.id, label: b.label, tagline: b.tagline, desc: b.desc, accent: b.accent })),
  };
}

/**
 * 单个榜单明细：排名 + 行情 + 技术指标 + 推荐理由
 */
async function recommendBoard(boardId, { limit = SHOW_LIMIT } = {}) {
  const board = BOARD_MAP[boardId];
  if (!board) throw Object.assign(new Error(`未知榜单：${boardId}`), { code: 'BAD_PARAM' });

  const res = await W.screenRanking({ type: board.type, limit, asc: board.asc, extra: board.extra || [] });
  const meta = parseRankMeta(res.text);
  // 个别榜单（如北向上榜）不响应 --limit，统一在此截断，保证「每个榜单 50 只」
  const rows = (res.rows || []).slice(0, limit);

  const codes = rows.map((r) => clean(r['代码'])).filter(Boolean);

  const [quotes, techRes] = await Promise.all([
    codes.length ? require('./catalog').fetchQuotes(codes) : Promise.resolve({}),
    // technical 单次最多 10 个代码，由 technicalBatch 自动分批（50 只 → 5 批并发）
    codes.length ? W.technicalBatch(codes).catch(() => null) : Promise.resolve(null),
  ]);

  // technical 批量结果按 code 归档
  const techMap = {};
  if (techRes && techRes.rows) {
    techRes.rows.forEach((t) => { const c = clean(t.code); if (c) techMap[c] = t; });
  }

  // 指标列以**表头**为准（不同 limit 下端列会变化，用首行键名会漏列）
  const tableHeader = (res.tables && res.tables[0] && res.tables[0].header) || [];
  const metricKeys = (tableHeader.length ? tableHeader : Object.keys(rows[0] || {}))
    .filter((k) => !['#', '代码', '名称', 'code', 'name'].includes(k));

  const list = rows.map((r, i) => {
    const code = clean(r['代码']);
    const q = quotes[code] || {};
    const metrics = {};
    metricKeys.forEach((k) => {
      const key = METRIC_ALIAS[k] || k;
      const n = W.toNum(r[k]);
      metrics[key] = n !== null ? n : clean(r[k]);
    });

    const tRaw = techMap[code] || {};
    const tech = tRaw && Object.keys(tRaw).length ? {
      closePrice: W.toNum(tRaw.closePrice),
      MA_5: W.toNum(tRaw.MA_5), MA_10: W.toNum(tRaw.MA_10), MA_20: W.toNum(tRaw.MA_20),
      MA_60: W.toNum(tRaw.MA_60), MA_120: W.toNum(tRaw.MA_120), MA_250: W.toNum(tRaw.MA_250),
      MACD: W.toNum(tRaw.MACD), DIF: W.toNum(tRaw.DIF), DEA: W.toNum(tRaw.DEA),
      KDJ_K: W.toNum(tRaw.KDJ_K), KDJ_D: W.toNum(tRaw.KDJ_D), KDJ_J: W.toNum(tRaw.KDJ_J),
      RSI_6: W.toNum(tRaw.RSI_6), RSI_12: W.toNum(tRaw.RSI_12), RSI_24: W.toNum(tRaw.RSI_24),
      BOLL_UPPER: W.toNum(tRaw.BOLL_UPPER), BOLL_MID: W.toNum(tRaw.BOLL_MID), BOLL_LOWER: W.toNum(tRaw.BOLL_LOWER),
    } : null;

    const stock = {
      rank: Number(clean(r['#'])) || i + 1,
      code,
      name: clean(r['名称']) || q.name || code,
      total: meta.total,
      metrics, tech,
      quote: q,
    };
    const { reasons, risks } = buildReasons(stock, board, {});

    // 展示用指标（按榜单配置的顺序挑出有值的）
    const metricList = (board.metrics || [])
      .filter((k) => metrics[k] !== null && metrics[k] !== undefined && METRIC_DISPLAY[k])
      .map((k) => ({ key: k, ...METRIC_DISPLAY[k], value: metrics[k] }));

    return {
      rank: stock.rank,
      code, name: stock.name,
      market: q.market || null,
      price: q.price === undefined ? null : q.price,
      changePct: q.changePct === undefined ? null : q.changePct,
      turnoverRate: q.turnoverRate === undefined ? null : q.turnoverRate,
      marketCap: q.marketCap === undefined ? null : q.marketCap,
      metrics,
      metricList,
      scores: {
        comp: metrics.CompScore === undefined ? null : metrics.CompScore,
        fundamental: metrics.FunmScore === undefined ? null : metrics.FunmScore,
        technical: metrics.TecScore === undefined ? null : metrics.TecScore,
        capital: metrics.CapScore === undefined ? null : metrics.CapScore,
        risk: metrics.RiskScore === undefined ? null : metrics.RiskScore,
      },
      tech,
      reasons,
      risks,
    };
  });

  return {
    board: {
      id: board.id, label: board.label, tagline: board.tagline, desc: board.desc, accent: board.accent,
      sortMetric: board.sortMetric || null,
      sortMetricLabel: board.sortMetric && METRIC_DISPLAY[board.sortMetric] ? METRIC_DISPLAY[board.sortMetric].label : null,
      asc: !!board.asc,
    },
    dataDate: meta.date,
    universe: meta.total,
    sortedAsc: !!board.asc,
    wantLimit: limit,
    count: list.length,
    updatedAt: res.fetchedAt,
    list,
    disclaimer: '榜单由公开市场数据量化排序生成，推荐理由均引自对应数据字段，仅供研究参考，不构成任何投资建议。市场有风险，决策需谨慎。',
  };
}

module.exports = { boardCatalog, recommendBoard, BOARDS, METRIC_DISPLAY, SHOW_LIMIT };
