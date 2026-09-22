'use strict';
/**
 * picker.js — AI 选股指南引擎
 *
 * 三大能力（所有结论均可溯源，每条理由引用真实字段与阈值）：
 *   1. 每日买入推荐 runDailyPick()：全市场初筛 → 硬性过滤 → 多维评分 → 输出 3–10 只
 *   2. 持仓持续分析 analyzeHoldings()：技术面 + 基本面 + 盈亏纪律 → 卖出 / 减仓 / 持有
 *   3. 结果落盘（data/daily-pick.json）并推送通知，供前端展示与通知中心提醒
 *
 * 口径声明：本引擎是「量化初筛 + 规则化判读」，不是预测模型；
 * 所有阈值在附录 B.2.7 / B.2.8 公开，可逐条复核。
 */

const W = require('./westock');
const A = require('./analytics');
const RECOMMEND = require('./recommend');

/** 北京时间当天（不依赖服务器时区） */
function bjtToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const clean = (v) => (v === '--' || v === '-' || v === '' ? null : v);

// ============================================================
// 一、每日买入推荐
// ============================================================

/** 初筛池规模：取全市场综合评分前 N 名作为候选池 */
const UNIVERSE = 120;
/** 输出数量目标（硬性范围 3–10） */
const PICK_MIN = 3;
const PICK_MAX = 10;
const PICK_TARGET = 8;

/**
 * 多维加权评分（0–100）：四类评分 + 技术结构微调。
 * 权重按「激进度档案」差异化（见 PROFILES）：
 *   保守型偏基本面与风控（控制回撤优先）；
 *   稳健型均衡（综合评分权重最高，覆盖面最广）；
 *   进取型偏技术与资金（追逐动量与主力参与度，容忍更高波动）。
 */
const PROFILES = {
  conservative: {
    key: 'conservative', label: '保守型', tagline: '控制回撤优先，宁缺毋滥',
    desc: '以基本面质量与风控评分为核心，只选财务扎实、波动可控的标的；对估值、换手与短线热度施加更严格的排除条件。适合低风险承受能力、追求稳健回报的投资者。',
    accent: '#0f9d58',
    weights: { comp: 0.25, fun: 0.30, tec: 0.10, cap: 0.05, risk: 0.30 },
    tiers: [
      { name: '严格', desc: '综合 ≥72、基本面 ≥62、风控 ≥70、现价 ≥ MA20×99%', fn: (s) => s.metrics.CompScore >= 72 && (s.metrics.FunmScore === undefined || s.metrics.FunmScore >= 62) && (s.metrics.RiskScore === undefined || s.metrics.RiskScore >= 70) && s.trendOk === true },
      { name: '适度', desc: '综合 ≥66、基本面 ≥52、风控 ≥62、现价 ≥ MA20×97%', fn: (s) => s.metrics.CompScore >= 66 && (s.metrics.FunmScore === undefined || s.metrics.FunmScore >= 52) && (s.metrics.RiskScore === undefined || s.metrics.RiskScore >= 62) && s.trendOk !== false },
      { name: '底线', desc: '仅排除危险信号与保守型附加排除', fn: () => true },
    ],
    trendTolerances: [0.01, 0.03, 1],
    targetMax: 6,
    positionHint: '仓位纪律：建议单只不超过总仓位 10%，组合仓位 3–5 成，分 2–3 批建仓；跌破止损参考位即执行，不摊平。',
    extraExclude: (s) => {
      const { tech, quote, metrics } = s;
      if (quote && quote.turnoverRate !== null && quote.turnoverRate > 15) return `换手率 ${A.round(quote.turnoverRate, 2)}% 过高，波动超保守型容忍度`;
      if (metrics.PE_TTM !== undefined && metrics.PE_TTM !== null && metrics.PE_TTM > 60) return `PE(TTM) ${A.round(metrics.PE_TTM, 1)} 倍偏高，估值超出保守型上限`;
      if (tech && tech.RSI_6 !== null && tech.RSI_6 !== undefined && tech.RSI_6 >= 70) return `RSI6 ${A.round(tech.RSI_6, 1)} 偏热，保守型要求动能温和`;
      if (quote && quote.marketCap !== null && quote.marketCap !== undefined && quote.marketCap < 100) return `总市值 ${A.round(quote.marketCap, 0)} 亿元偏小，保守型仅选大市值`;
      return null;
    },
    riskFocus: '回撤与估值',
  },
  balanced: {
    key: 'balanced', label: '稳健型', tagline: '均衡口径，攻守兼备',
    desc: '以综合评分（覆盖基本面 / 技术 / 资金 / 风控四维）为主轴的均衡口径，趋势与质量并重。适合大多数投资者的默认选择。',
    accent: '#2563eb',
    weights: { comp: 0.40, fun: 0.20, tec: 0.20, cap: 0.10, risk: 0.10 },
    tiers: [
      { name: '严格', desc: '综合 ≥68、基本面 ≥55、风控 ≥62、现价 ≥ MA20×98%', fn: (s) => s.metrics.CompScore >= 68 && (s.metrics.FunmScore === undefined || s.metrics.FunmScore >= 55) && (s.metrics.RiskScore === undefined || s.metrics.RiskScore >= 62) && s.trendOk === true },
      { name: '适度', desc: '综合 ≥62、基本面 ≥45、风控 ≥55、现价 ≥ MA20×95%', fn: (s) => s.metrics.CompScore >= 62 && (s.metrics.FunmScore === undefined || s.metrics.FunmScore >= 45) && (s.metrics.RiskScore === undefined || s.metrics.RiskScore >= 55) && s.trendOk !== false },
      { name: '底线', desc: '仅排除危险信号（ST / 涨停追高 / 短线超买 / 突破布林上轨 / 无行情数据）', fn: () => true },
    ],
    trendTolerances: [0.02, 0.05, 1],
    targetMax: 8,
    positionHint: '仓位纪律：建议单只不超过总仓位 15%，组合仓位 5–7 成；跌破 MA20×0.97 参考止损位减半仓。',
    extraExclude: () => null,
    riskFocus: '趋势与质量平衡',
  },
  aggressive: {
    key: 'aggressive', label: '进取型', tagline: '追逐动量与资金，容忍波动',
    desc: '以技术结构与主力资金为主轴，捕捉强势动量标的；放宽估值与短期热度限制，接受更高波动以换取弹性。适合风险承受能力强、纪律执行到位的交易型投资者。',
    accent: '#d92b2b',
    weights: { comp: 0.30, fun: 0.10, tec: 0.30, cap: 0.20, risk: 0.10 },
    tiers: [
      { name: '严格', desc: '综合 ≥62 且技术评分 ≥55 且现价 ≥ MA20×97%', fn: (s) => s.metrics.CompScore >= 62 && (s.metrics.TecScore === undefined || s.metrics.TecScore >= 55) && s.trendOk !== false },
      { name: '适度', desc: '综合 ≥55、技术评分 ≥48', fn: (s) => s.metrics.CompScore >= 55 && (s.metrics.TecScore === undefined || s.metrics.TecScore >= 48) },
      { name: '底线', desc: '仅排除危险信号与进取型附加排除', fn: () => true },
    ],
    trendTolerances: [0.03, 0.08, 1],
    targetMax: 10,
    positionHint: '仓位纪律：波动大，建议单只不超过总仓位 20% 且必须预设止损（默认 MA20×0.97，破位无条件执行）；组合仓位可至 7–8 成，但严禁追加亏损头寸。',
    extraExclude: (s) => {
      const { tech } = s;
      if (tech && tech.RSI_6 !== null && tech.RSI_6 !== undefined && tech.RSI_6 >= 85) return `RSI6 ${A.round(tech.RSI_6, 1)} 极端超买，连进取型也排除`;
      return null;
    },
    riskFocus: '动量与资金弹性',
  },
};

const PROFILE_ORDER = ['conservative', 'balanced', 'aggressive'];
/** 兼容旧引用：稳健型即原默认口径 */
const WEIGHTS = PROFILES.balanced.weights;

/** 按激进度档案取过滤分级 */
function tiersFor(profileKey) {
  return (PROFILES[profileKey] || PROFILES.balanced).tiers;
}

/** 排除性风险信号：任何 Tier 都不放松（宁缺毋滥的底线）+ 激进度档案附加排除 */
function hardExcluded(s, profileKey) {
  const { name, quote, tech, metrics } = s;
  if (/ST/i.test(String(name || ''))) return 'ST 风险警示股';
  if (!quote || quote.price === null || quote.price === undefined) return '无行情数据';
  if (quote.changePct !== null && quote.changePct >= 9.7) return '当日已涨停，追高风险大';
  if (tech) {
    if (tech.RSI_6 !== null && tech.RSI_6 !== undefined && tech.RSI_6 >= 80) return `RSI6 ${A.round(tech.RSI_6, 1)} 短线超买`;
    if (tech.BOLL_UPPER !== null && tech.BOLL_LOWER !== null && tech.closePrice !== null
      && tech.BOLL_UPPER !== tech.BOLL_LOWER) {
      const pos = ((tech.closePrice - tech.BOLL_LOWER) / (tech.BOLL_UPPER - tech.BOLL_LOWER)) * 100;
      if (pos > 100) return '股价已突破布林上轨，短线波动加剧';
    }
  }
  if (metrics.CompScore === undefined || metrics.CompScore === null) return '缺少综合评分';
  const profile = PROFILES[profileKey] || PROFILES.balanced;
  return profile.extraExclude ? profile.extraExclude(s) : null;
}

/** 均线趋势判断：现价相对 MA20 的位置（各档案 Tier 1/2 用，容差由档案给出） */
function trendVsMa20(s, tolerance) {
  const { tech, quote } = s;
  if (!tech || tech.MA_20 === null || tech.MA_20 === undefined || !quote || quote.price === null) return null;
  return quote.price >= tech.MA_20 * (1 - tolerance);
}

/** 技术结构加分（0–10，叠加在加权评分上）——按激进度档案差异化 */
function techBonus(s, profileKey) {
  let bonus = 0;
  const { tech, quote } = s;
  const rsiMid = profileKey === 'aggressive' ? 75 : profileKey === 'conservative' ? 62 : 70;
  if (tech) {
    const { MA_5, MA_20, MA_60, MACD, RSI_6, BOLL_UPPER, BOLL_LOWER, closePrice } = tech;
    if (MA_5 !== null && MA_20 !== null && MA_60 !== null && MA_5 > MA_20 && MA_20 > MA_60) bonus += 3;
    if (MACD !== null && MACD !== undefined) bonus += MACD > 0 ? 2 : -2;
    if (RSI_6 !== null && RSI_6 !== undefined) {
      if (profileKey === 'aggressive') {
        if (RSI_6 >= 55 && RSI_6 < 80) bonus += 2;           // 强动能是进取型优点
        else if (RSI_6 < 40) bonus -= 1;
      } else if (profileKey === 'conservative') {
        if (RSI_6 >= 40 && RSI_6 < 62) bonus += 2;           // 温和动能
        else if (RSI_6 >= rsiMid) bonus -= 3;                // 过热重罚
      } else {
        if (RSI_6 >= 30 && RSI_6 < 60) bonus += 2;           // 动能温和，仍有上行空间
        else if (RSI_6 >= rsiMid) bonus -= 2;                // 动能过热
      }
    }
    if (BOLL_UPPER !== null && BOLL_LOWER !== null && closePrice !== null && BOLL_UPPER !== BOLL_LOWER) {
      const pos = ((closePrice - BOLL_LOWER) / (BOLL_UPPER - tech.BOLL_LOWER)) * 100;
      if (profileKey === 'aggressive') { if (pos >= 60 && pos <= 95) bonus += 2; }
      else if (profileKey === 'conservative') { if (pos >= 35 && pos <= 70) bonus += 2; }
      else if (pos >= 45 && pos <= 85) bonus += 2;           // 中上轨运行且未过热
    }
  }
  if (quote && quote.turnoverRate !== null && quote.turnoverRate !== undefined) {
    if (profileKey === 'aggressive') {
      if (quote.turnoverRate >= 3 && quote.turnoverRate <= 20) bonus += 2;  // 活跃资金参与
      else if (quote.turnoverRate > 25) bonus -= 2;
    } else if (quote.turnoverRate >= 1 && quote.turnoverRate <= 10) bonus += 1;
    else if (quote.turnoverRate > (profileKey === 'conservative' ? 15 : 20)) bonus -= 2;  // 换手过热
  }
  return bonus;
}

/** 综合量化分（0–100 + 技术微调，封顶 105）——权重按档案 */
function pickScore(s, profileKey) {
  const w = (PROFILES[profileKey] || PROFILES.balanced).weights;
  const m = s.metrics;
  const val = (k) => (typeof m[k] === 'number' ? m[k] : null);
  const base = (val('CompScore') || 0) * w.comp
    + (val('FunmScore') || 0) * w.fun
    + (val('TecScore') || 0) * w.tec
    + (val('CapScore') || 0) * w.cap
    + (val('RiskScore') || 0) * w.risk;
  return A.round(Math.min(105, base + techBonus(s, profileKey)), 2);
}

/**
 * 生成每日买入推荐（按激进度档案差异化）。
 * @param {object} store 持久化存储
 * @param {object} opts.force 强制重新生成；profile 激进度：conservative | balanced | aggressive
 * @returns {Promise<object>} 当日推荐结果（含候选池统计、过滤漏斗与免责声明）
 */
async function runDailyPick(store, { force = false, profile: profileKey = 'balanced' } = {}) {
  const profile = PROFILES[profileKey] || PROFILES.balanced;
  const usedKey = profile.key;
  const today = bjtToday();
  const snapKey = `daily-pick-${usedKey}`;
  if (!force) {
    const cached = store.loadSnapshot(snapKey);
    if (cached && cached.data && cached.data.date === today) return { ...cached.data, cached: true };
  }

  const board = await RECOMMEND.recommendBoard('comp', { limit: UNIVERSE });
  const pool = board.list.map((x) => ({
    ...x,
    tech: x.tech || null,
    quote: { price: x.price, changePct: x.changePct, turnoverRate: x.turnoverRate, marketCap: x.marketCap },
  }));

  // 排除硬性风险信号（含档案附加排除）
  const excluded = [];
  const candidates = [];
  pool.forEach((s) => {
    const why = hardExcluded(s, usedKey);
    if (why) { excluded.push({ code: s.code, name: s.name, reason: why }); return; }
    candidates.push(s);
  });

  // 分级过滤（按档案阈值）：从严格到底线，直到凑足目标数量
  const TIERS = tiersFor(usedKey);
  let tierUsed = TIERS[TIERS.length - 1];
  let passing = [];
  const funnel = [];
  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i];
    const s2 = candidates.map((s) => ({ ...s, trendOk: trendVsMa20(s, profile.trendTolerances[i]) }));
    passing = s2.filter(tier.fn).sort((a, b) => pickScore(b, usedKey) - pickScore(a, usedKey));
    funnel.push({ tier: tier.name, desc: tier.desc, passed: passing.length });
    if (passing.length >= PICK_MIN) { tierUsed = tier; break; }
    tierUsed = tier;
  }

  const picks = passing.slice(0, profile.targetMax).map((s, i) => {
    const score = pickScore(s, usedKey);
    const reasons = [];
    const risks = [];
    reasons.push(`全市场综合评分 ${s.metrics.CompScore} 分（第 ${s.rank} 名，前 ${A.round((s.rank / (board.universe || UNIVERSE)) * 100, 2)}%）入选初筛池`);
    reasons.push(`${profile.label}量化综合分 ${score}（${Object.entries(profile.weights).map(([k, v]) => `${{ comp: '综合', fun: '基本面', tec: '技术', cap: '资金', risk: '风控' }[k]}${Math.round(v * 100)}%`).join(' + ')} 加权 + 技术微调）`);
    if (s.metrics.FunmScore !== undefined) reasons.push(`基本面评分 ${s.metrics.FunmScore}（${gradeCn(s.metrics.FunmScore)}）`);
    if (s.metrics.RiskScore !== undefined) reasons.push(`风控评分 ${s.metrics.RiskScore}（数值越高代表波动与回撤控制越好）`);
    const t = s.tech || {};
    if (t.MA_5 !== null && t.MA_20 !== null && t.MA_60 !== null && t.MA_5 > t.MA_20 && t.MA_20 > t.MA_60) {
      reasons.push(`均线多头排列（MA5 ${A.round(t.MA_5, 2)} > MA20 ${A.round(t.MA_20, 2)} > MA60 ${A.round(t.MA_60, 2)}），中期趋势向上`);
    }
    if (t.MACD !== null && t.MACD !== undefined) reasons.push(`MACD ${t.MACD > 0 ? '红柱' : '绿柱'} ${A.round(t.MACD, 3)}${t.DIF !== null && t.DEA !== null ? `，DIF ${A.round(t.DIF, 3)} / DEA ${A.round(t.DEA, 3)}` : ''}`);
    if (t.RSI_6 !== null && t.RSI_6 !== undefined) {
      const r6 = A.round(t.RSI_6, 1);
      reasons.push(`RSI6 ${r6}，${profileKey === 'aggressive' && t.RSI_6 >= 55 ? '短线动能强劲（进取型口径下为优势项）' : t.RSI_6 >= 60 ? '短线动能偏强' : t.RSI_6 >= 30 ? '动能温和、仍有空间' : '动能偏弱'}`);
    }
    if (s.quote.turnoverRate !== null && s.quote.turnoverRate !== undefined) reasons.push(`换手率 ${A.round(s.quote.turnoverRate, 2)}%，筹码活跃度${s.quote.turnoverRate > 10 ? '偏高' : '正常'}`);
    if (profileKey === 'conservative' && s.quote.marketCap !== null && s.quote.marketCap !== undefined) {
      reasons.push(`总市值 ${A.round(s.quote.marketCap, 0)} 亿元，满足保守型大市值要求`);
    }

    // 参考价位（明确标注为平台参考，非预测）
    const ref = {};
    if (t.MA_20 !== null && t.MA_20 !== undefined) ref.support = A.round(t.MA_20, 2);
    if (t.BOLL_UPPER !== null && t.BOLL_UPPER !== undefined) ref.resistance = A.round(t.BOLL_UPPER, 2);
    if (t.MA_20 !== null && t.MA_20 !== undefined) ref.stopLoss = A.round(t.MA_20 * 0.97, 2);

    if (t.RSI_6 !== null && t.RSI_6 !== undefined && t.RSI_6 >= 70) risks.push(`RSI6 ${A.round(t.RSI_6, 1)} 偏高，短线追高风险大`);
    if (s.quote.turnoverRate !== null && s.quote.turnoverRate > 20) risks.push(`换手率 ${A.round(s.quote.turnoverRate, 2)}% 过热，波动可能加大`);
    if (s.metrics.PE_TTM !== undefined && s.metrics.PE_TTM !== null && s.metrics.PE_TTM > 80) risks.push(`PE(TTM) ${A.round(s.metrics.PE_TTM, 1)} 倍偏高`);
    if (profileKey === 'conservative') risks.push(`重点监控${profile.riskFocus}：若回撤超过 8% 或估值分位大幅抬升，应优先降仓位而非补仓`);
    if (profileKey === 'aggressive') risks.push(`${profile.riskFocus}型标的波动大：动量反转（MACD 转绿柱 / 跌破 MA20）即离场，不与趋势争辩`);
    if (profileKey === 'balanced') risks.push(`关注${profile.riskFocus}：技术结构与基本面出现背离时，以基本面为准`);

    return {
      rank: i + 1,
      code: s.code,
      name: s.name,
      price: s.quote.price,
      changePct: s.quote.changePct,
      turnoverRate: s.quote.turnoverRate,
      marketCap: s.marketCap,
      metrics: s.metrics,
      pickScore: score,
      tier: tierUsed.name,
      ref,
      reasons: reasons.slice(0, 7),
      risks: risks.slice(0, 3),
    };
  });

  const result = {
    date: today,
    generatedAt: new Date().toISOString(),
    profile: { key: profile.key, label: profile.label, tagline: profile.tagline, desc: profile.desc, accent: profile.accent, weights: profile.weights, positionHint: profile.positionHint, riskFocus: profile.riskFocus },
    universe: board.universe,
    poolSize: pool.length,
    excludedCount: excluded.length,
    tier: tierUsed.name,
    tierDesc: tierUsed.desc,
    funnel,
    target: PICK_TARGET,
    count: picks.length,
    excludedSample: excluded.slice(0, 6),
    list: picks,
    weights: profile.weights,
    source: '腾讯自选股数据接口（综合评分初筛 + 平台多维过滤与评分）',
    disclaimer: '本推荐由量化规则自动生成（按所选激进度档案差异化），用于研究参考与初筛提示，不构成任何投资建议；买卖决策请结合自身风险承受能力并自担风险。参考价位为均线衍生值，非预测。',
  };

  store.saveSnapshot(snapKey, result);

  // 推送通知（去重指纹按「日期 + 档案」，每档每天至多一条）
  if (picks.length) {
    store.pushNotifications([{
      type: 'daily_pick', level: 'normal', category: 'AI 选股',
      title: `AI 选股（${profile.label}）：今日推荐 ${picks.length} 只（${picks.map((x) => x.name).slice(0, 3).join('、')}${picks.length > 3 ? ' 等' : ''}）`,
      body: `初筛池 ${pool.length} 只，过滤后入选 ${picks.length} 只（${tierUsed.name}口径）。可在「AI 选股 → 今日推荐」查看完整理由与参考价位。`,
      fingerprint: `daily-pick|${usedKey}|${today}`,
      meta: { date: today, profile: usedKey },
    }]);
  }
  return { ...result, cached: false };
}

function gradeCn(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 90) return '优秀';
  if (v >= 80) return '优良';
  if (v >= 70) return '良好';
  if (v >= 60) return '中性偏上';
  if (v >= 50) return '中性';
  return '偏弱';
}

// ============================================================
// 二、持仓持续分析（卖出判读）
// ============================================================

/**
 * 卖出信号规则（全部引用真实字段，阈值见附录 B.2.8）：
 *   S1 趋势破位：现价 < MA20 且 MA5 < MA20
 *   S2 动能转弱：MACD < 0（绿柱）
 *   S3 短线过热：RSI6 ≥ 80（先减仓而非清仓）
 *   S4 波动预警：股价突破布林上轨（pos > 100）
 *   S5 基本面转弱：财报质量评分 ≤ 4（D/E 级）
 *   S6 止损纪律：浮动亏损 ≤ −15%
 *   S7 止盈纪律：浮动盈利 ≥ +40%（提示分批兑现）
 */
const SELL_RULES = [
  { id: 'S1', label: '趋势破位', level: 'high', test: (c) => c.tech && c.tech.MA_20 !== null && c.price !== null && c.price < c.tech.MA_20 && c.tech.MA_5 !== null && c.tech.MA_5 < c.tech.MA_20,
    text: (c) => `现价 ${c.price} 已跌破 20 日均线 ${A.round(c.tech.MA_20, 2)}，且 MA5 ${A.round(c.tech.MA_5, 2)} 位于其下，短期趋势走坏` },
  { id: 'S2', label: '动能转弱', level: 'mid', test: (c) => c.tech && c.tech.MACD !== null && c.tech.MACD !== undefined && c.tech.MACD < 0,
    text: (c) => `MACD 绿柱 ${A.round(c.tech.MACD, 3)}，短线动能向下` },
  { id: 'S3', label: '短线过热', level: 'mid', test: (c) => c.tech && c.tech.RSI_6 !== null && c.tech.RSI_6 !== undefined && c.tech.RSI_6 >= 80,
    text: (c) => `RSI6 ${A.round(c.tech.RSI_6, 1)} 进入超买区，回吐风险大，建议先减仓锁盈` },
  { id: 'S4', label: '波动预警', level: 'low', test: (c) => c.bollPos !== null && c.bollPos > 100,
    text: (c) => `股价已突破布林上轨（轨道位置 ${A.round(c.bollPos, 0)}%），波动加剧` },
  { id: 'S5', label: '基本面转弱', level: 'high', test: (c) => c.finScore !== null && c.finScore <= 4,
    text: (c) => `财报质量评分仅 ${c.finScore} / 10（${c.finGrade} 级），盈利与财务质量偏弱` },
  { id: 'S6', label: '止损纪律', level: 'high', test: (c) => c.pnlPct !== null && c.pnlPct <= -15,
    text: (c) => `浮动亏损 ${A.round(c.pnlPct, 2)}%，已触及 −15% 止损纪律线` },
  { id: 'S7', label: '止盈提示', level: 'low', test: (c) => c.pnlPct !== null && c.pnlPct >= 40,
    text: (c) => `浮动盈利 +${A.round(c.pnlPct, 2)}%，可考虑分批兑现、控制回吐` },
];

/**
 * 对持仓逐只分析并给出操作判读。
 * @returns {Promise<object>} 汇总结果（组合概况 + 逐只判读）
 */
async function analyzeHoldings(store) {
  const holdings = (store.holdings || []).slice();
  if (!holdings.length) {
    return { updatedAt: new Date().toISOString(), total: 0, summary: null, list: [], note: '暂无持仓记录，请先在「自选与持仓」中添加。' };
  }

  const codes = holdings.map((h) => h.code);
  const [quoteRes, techRes] = await Promise.all([
    W.quote(codes).catch(() => null),
    W.technicalBatch(codes).catch(() => null),
  ]);
  const qMap = {};
  ((quoteRes && quoteRes.rows) || []).forEach((r) => { if (r.code) qMap[r.code] = r; });
  const tMap = {};
  ((techRes && techRes.rows) || []).forEach((t) => { const c = clean(t.code); if (c) tMap[c] = t; });

  // 财报质量评分（逐只拉取，持仓数量有限；失败不阻断）
  const finList = await Promise.allSettled(holdings.map((h) => require('./service').companyFinance(h.code, { periods: 2 })));

  const list = holdings.map((h, i) => {
    const q = qMap[h.code] || {};
    const t = tMap[h.code] || {};
    const price = W.toNum(q.price);
    const cost = Number(h.cost) || 0;
    const qty = Number(h.qty) || 0;
    const marketValue = price !== null ? A.round(price * qty, 2) : null;
    const costValue = A.round(cost * qty, 2);
    const pnl = marketValue !== null ? A.round(marketValue - costValue, 2) : null;
    const pnlPct = costValue > 0 && pnl !== null ? A.round((pnl / costValue) * 100, 2) : null;

    const tech = {
      closePrice: W.toNum(t.closePrice),
      MA_5: W.toNum(t.MA_5), MA_10: W.toNum(t.MA_10), MA_20: W.toNum(t.MA_20), MA_60: W.toNum(t.MA_60),
      MACD: W.toNum(t.MACD), DIF: W.toNum(t.DIF), DEA: W.toNum(t.DEA),
      RSI_6: W.toNum(t.RSI_6), RSI_12: W.toNum(t.RSI_12),
      BOLL_UPPER: W.toNum(t.BOLL_UPPER), BOLL_MID: W.toNum(t.BOLL_MID), BOLL_LOWER: W.toNum(t.BOLL_LOWER),
    };
    const bollPos = (tech.BOLL_UPPER !== null && tech.BOLL_LOWER !== null && price !== null && tech.BOLL_UPPER !== tech.BOLL_LOWER)
      ? ((price - tech.BOLL_LOWER) / (tech.BOLL_UPPER - tech.BOLL_LOWER)) * 100 : null;

    const fin = finList[i].status === 'fulfilled' ? finList[i].value : null;
    const finScore = fin ? fin.score : null;
    const finGrade = fin ? fin.grade : null;

    const ctx = { price, tech, bollPos, finScore, finGrade, pnl, pnlPct };
    const signals = SELL_RULES.filter((r) => { try { return r.test(ctx); } catch (_) { return false; } })
      .map((r) => ({ id: r.id, label: r.label, level: r.level, text: r.text(ctx) }));

    // 持有健康度（0–10）：7 分起，按信号等级扣分
    let health = 7;
    signals.forEach((s) => { health += s.level === 'high' ? -3 : s.level === 'mid' ? -1.5 : -0.5; });
    if (finScore !== null && finScore >= 6.5) health += 1;          // 基本面良好
    if (tech.MA_5 !== null && tech.MA_20 !== null && tech.MA_5 > tech.MA_20 && price !== null && price > tech.MA_20) health += 1;
    health = A.round(Math.max(0, Math.min(10, health)), 1);

    // 判读：卖出信号 ≥2 条、或含 2 条以上 high、或「趋势破位 + 动能转弱」组合 → 卖出
    const highCount = signals.filter((s) => s.level === 'high').length;
    const hasS1 = signals.some((s) => s.id === 'S1');
    const hasS2 = signals.some((s) => s.id === 'S2');
    let verdict;
    let verdictTone;
    if (signals.length >= 2 && (highCount >= 2 || (hasS1 && hasS2))) { verdict = '建议卖出'; verdictTone = 'down'; }
    else if (signals.length >= 2 || highCount >= 1) { verdict = '建议减仓'; verdictTone = 'warn'; }
    else if (signals.length === 1) { verdict = '关注'; verdictTone = 'warn'; }
    else { verdict = '继续持有'; verdictTone = 'up'; }

    const holds = [];
    if (verdict !== '建议卖出') {
      if (tech.MA_20 !== null && price !== null && price > tech.MA_20) holds.push(`现价 ${price} 站上 20 日均线 ${A.round(tech.MA_20, 2)}，中期趋势未破坏`);
      if (tech.MACD !== null && tech.MACD > 0) holds.push(`MACD 红柱 ${A.round(tech.MACD, 3)}，动能仍在`);
      if (finScore !== null && finScore >= 6.5) holds.push(`财报质量评分 ${finScore} / 10（${finGrade} 级），基本面支撑仍在`);
      if (pnlPct !== null && pnlPct > 0) holds.push(`当前浮盈 +${A.round(pnlPct, 2)}%`);
    }

    return {
      code: h.code, name: clean(q.name) || h.name || h.code,
      qty, cost, price,
      marketValue, costValue, pnl, pnlPct,
      dayChangePct: W.toNum(q.change_percent),
      finScore, finGrade,
      health, verdict, verdictTone,
      signals, holds,
      ref: { ma20: tech.MA_20 === null ? null : A.round(tech.MA_20, 2), stop: tech.MA_20 === null ? null : A.round(tech.MA_20 * 0.97, 2) },
    };
  });

  const totalCost = A.round(list.reduce((k, x) => k + (x.costValue || 0), 0), 2);
  const totalValue = A.round(list.reduce((k, x) => k + (x.marketValue || 0), 0), 2);
  const totalPnl = A.round(totalValue - totalCost, 2);
  const summary = {
    holdings: list.length,
    totalCost, totalValue, totalPnl,
    totalPnlPct: totalCost > 0 ? A.round((totalPnl / totalCost) * 100, 2) : null,
    dayPnl: A.round(list.reduce((k, x) => k + (x.marketValue !== null && x.dayChangePct !== null ? x.marketValue * x.dayChangePct / (100 + x.dayChangePct) : 0), 0), 2),
    sellCount: list.filter((x) => x.verdict === '建议卖出').length,
    reduceCount: list.filter((x) => x.verdict === '建议减仓').length,
    watchCount: list.filter((x) => x.verdict === '关注').length,
    holdCount: list.filter((x) => x.verdict === '继续持有').length,
  };

  return {
    updatedAt: new Date().toISOString(),
    total: list.length,
    summary,
    list,
    rules: SELL_RULES.map((r) => ({ id: r.id, label: r.label, level: r.level })),
    source: '腾讯自选股数据接口 + 平台自建财报质量评分（B.2.2）',
    disclaimer: '持仓判读由规则引擎生成，仅作纪律提示与研究参考，不构成投资建议；请结合自身成本与风险承受能力决策。',
  };
}

module.exports = { runDailyPick, analyzeHoldings, PROFILES, PROFILE_ORDER, PICK_MIN, PICK_MAX, PICK_TARGET, UNIVERSE, WEIGHTS };
