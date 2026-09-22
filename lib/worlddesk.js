'use strict';
/**
 * worlddesk.js — 国际形势金融分析板块
 *
 * 组成：
 *   1. 全球市场快照：美三大指数 / 恒指 / 美元指数 / 贵金属 / 原油 实时行情
 *   2. 国际要闻聚合：美股三大指数、恒指、主要汇率品种的资讯接口 + 热闻榜国际条目，
 *      按 id 去重、按时间倒序
 *   3. 影响分析引擎：**规则化关键词映射**（非预测模型）——
 *      把要闻标题匹配到国际主题（货币政策 / 关税贸易 / 地缘冲突 / 能源 / 汇率干预 等），
 *      每个主题给出受影响资产与方向（利多 / 利空 / 双向），并引用命中的真实新闻标题。
 *      每条结论都可回溯到具体新闻，引擎规则透明可复核。
 */

const W = require('./westock');
const GM = require('./global-markets');

const clean = (v) => (v === '--' || v === '-' || v === '' ? null : v);

/** 影响分析的主题规则库：keywords 命中标题即归类；impact 给出资产方向映射 */
const THEMES = [
  {
    id: 'fed', title: '美联储与美元利率政策', keywords: ['美联储', 'Fed', 'FOMC', '降息', '加息', '联邦基金利率', '点阵图', '鲍威尔', '利率决议'],
    impacts: [
      { asset: '美元指数', tone: 'mixed', note: '偏鹰（加息/维持高利率）通常支撑美元；偏鸽（降息预期升温）通常压制美元' },
      { asset: '黄金 / 白银', tone: 'mixed', note: '降息预期升温利多贵金属（持有成本下降）；鹰派立场构成压制' },
      { asset: '美股估值', tone: 'mixed', note: '利率下行利好成长股估值；高利率环境压制长久期资产' },
      { asset: '人民币汇率', tone: 'mixed', note: '中美利差变化影响人民币与北向资金流向' },
    ],
  },
  {
    id: 'trade', title: '关税与国际贸易摩擦', keywords: ['关税', '贸易战', '贸易摩擦', '制裁', '出口管制', '加征', '301', '世贸', 'WTO'],
    impacts: [
      { asset: 'A 股出口链', tone: 'down', note: '加征关税与出口管制直接压制出口占比较高的制造与科技板块' },
      { asset: '黄金', tone: 'up', note: '贸易不确定性上升推升避险需求' },
      { asset: '人民币汇率', tone: 'down', note: '贸易顺差预期收窄对人民币构成压力' },
      { asset: '港股科技', tone: 'mixed', note: '受制裁清单与供应链消息影响波动加大' },
    ],
  },
  {
    id: 'geo', title: '地缘政治与冲突', keywords: ['地缘', '冲突', '导弹', '停火', '局势', '军事', '袭击', '中东', '俄乌', '红海', '演习'],
    impacts: [
      { asset: '黄金', tone: 'up', note: '避险情绪推升金价' },
      { asset: '原油', tone: 'up', note: '供给中断风险（运输通道 / 产区）推升油价' },
      { asset: '全球股市', tone: 'down', note: '风险偏好回落，指数承压；军工板块相对受益' },
      { asset: '美元 / 瑞郎 / 日元', tone: 'up', note: '传统避险货币需求上升' },
    ],
  },
  {
    id: 'energy', title: '能源供给与油价', keywords: ['原油', 'OPEC', '欧佩克', '减产', '增产', '油价', '天然气', '页岩油', '布伦特', 'WTI'],
    impacts: [
      { asset: '原油', tone: 'mixed', note: '减产 / 供给中断利多油价；增产与需求疲弱构成压制' },
      { asset: '通胀预期', tone: 'up', note: '油价上行推升通胀预期，或延后央行宽松节奏' },
      { asset: '航空 / 运输', tone: 'down', note: '燃油成本上升挤压利润' },
      { asset: '石油石化', tone: 'up', note: '油价上行利好上游开采环节盈利' },
    ],
  },
  {
    id: 'boj', title: '日本央行与日元', keywords: ['日银', '日本央行', '日元', '套息', '植田', '干预汇率', '外汇干预'],
    impacts: [
      { asset: '日元', tone: 'mixed', note: '加息 / 干预预期利多日元；维持超宽松构成压制' },
      { asset: '全球流动性', tone: 'mixed', note: '日元套息交易平仓会放大全球股市波动' },
      { asset: '人民币兑日元', tone: 'mixed', note: '影响中日贸易与出境成本' },
    ],
  },
  {
    id: 'ecb', title: '欧洲央行与欧元', keywords: ['欧央行', '欧洲央行', 'ECB', '拉加德', '欧元区', '欧元', '德国经济'],
    impacts: [
      { asset: '欧元', tone: 'mixed', note: '政策路径分化决定兑美元方向' },
      { asset: '欧洲股市', tone: 'mixed', note: '利率与能源成本共同影响盈利预期' },
      { asset: '美元指数', tone: 'mixed', note: '欧元在美元指数中权重最高，欧元强弱反向影响美元' },
    ],
  },
  {
    id: 'cn-policy', title: '中国政策与经济数据', keywords: ['中国央行', 'LPR', '降准', '人民币', '财政', '化债', '地产政策', '扩大内需', '国常会', '稳增长'],
    impacts: [
      { asset: 'A 股', tone: 'up', note: '宽松与稳增长政策改善盈利与流动性预期' },
      { asset: '港股', tone: 'up', note: '对内地政策弹性更高，南向资金跟随' },
      { asset: '人民币汇率', tone: 'up', note: '经济预期改善支撑汇率' },
      { asset: '大宗商品', tone: 'up', note: '中国需求预期影响工业金属与黑色系' },
    ],
  },
  {
    id: 'inflation', title: '通胀与经济数据', keywords: ['CPI', 'PPI', '通胀', '非农', '就业', 'GDP', 'PMI', '失业率', 'PCE'],
    impacts: [
      { asset: '美债收益率', tone: 'mixed', note: '通胀超预期推升收益率，降温则回落' },
      { asset: '贵金属', tone: 'mixed', note: '通胀韧性支撑抗通胀配置；但引发的鹰派预期压制金价' },
      { asset: '美股', tone: 'mixed', note: '数据决定降息路径定价，波动放大' },
    ],
  },
];

/** 风险偏好主题（用于整体基调判断） */
const RISK_OFF = ['geo', 'trade'];
const RISK_ON = ['cn-policy'];

function classifyTitle(title) {
  const t = String(title || '');
  return THEMES.filter((th) => th.keywords.some((k) => t.includes(k)));
}

/**
 * 生成国际形势分析。
 * @returns {Promise<object>} 快照 + 要闻 + 主题影响分析
 */
async function worldDesk({ newsLimit = 12 } = {}) {
  // ---------- 1. 全球市场快照 ----------
  const [indices, oilRes, metals] = await Promise.all([
    GM.globalIndices(),
    W.quote('hf_OIL').catch(() => null),
    GM.metalsBoard().catch(() => null),
  ]);
  const oilRow = ((oilRes && oilRes.rows) || [])[0] || {};
  const usdIdx = (await (async () => {
    const r = await W.quote('fxDINIW').catch(() => null);
    const row = ((r && r.rows) || [])[0] || {};
    return { code: 'fxDINIW', name: clean(row.name) || '美元指数', price: W.toNum(row.price), changePct: W.toNum(row.changePct), updateTime: clean(row.updateTime) };
  })());

  const snapshot = {
    updatedAt: new Date().toISOString(),
    indices: indices.list,
    usdIndex: usdIdx,
    oil: { code: 'hf_OIL', name: clean(oilRow.name) || '国际原油', price: W.toNum(oilRow.lastPrice), changePct: W.toNum(oilRow.changePct), currency: clean(oilRow.currency), updateTime: clean(oilRow.updateTime) },
    metals: (metals && metals.list || []).map((m) => ({ key: m.key, name: m.name, price: m.price, changePct: m.changePct, updateTime: m.updateTime })),
    source: '腾讯自选股数据接口',
  };

  // ---------- 2. 多源要闻聚合 ----------
  const sources = [
    { code: 'usDJI', label: '美股' }, { code: 'usIXIC', label: '美股' }, { code: 'hkHSI', label: '港股' },
    { code: 'fxUSDCNY', label: '人民币' }, { code: 'fxEURUSD', label: '欧元' }, { code: 'fxUSDJPY', label: '日元' },
  ];
  const settled = await Promise.allSettled(sources.map((s) => W.news(s.code, newsLimit)));
  const byId = new Map();
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    ((r.value && r.value.rows) || []).forEach((row) => {
      const id = clean(row.id);
      const title = clean(row.title);
      if (!id || !title || byId.has(id)) return;
      byId.set(id, {
        id, title,
        src: clean(row.src) || '未知来源',
        time: clean(row.time),
        url: clean(row.url),
        channel: sources[i].label,
      });
    });
  });
  // 热闻榜补充（限国际相关关键词，避免被 A 股个股消息淹没）
  const hot = await W.hotNews(40).catch(() => null);
  const GLOBAL_KW = ['美联储', '美国', '全球', '美元', '欧', '日本', '央行', '关税', '地缘', '原油', '黄金', '金价', '欧元', '日元', '贸易', '国际'];
  ((hot && hot.rows) || []).forEach((row) => {
    const id = clean(row.id);
    const title = clean(row.title);
    if (!id || !title || byId.has(id)) return;
    if (!GLOBAL_KW.some((k) => title.includes(k))) return;
    byId.set(id, {
      id, title, src: clean(row.source) || clean(row.src) || '热闻榜',
      time: null, url: clean(row.url), channel: '热闻',
    });
  });

  const news = [...byId.values()].sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

  // ---------- 3. 主题影响分析（规则化映射，逐条引用真实标题） ----------
  const themes = THEMES.map((th) => {
    const hits = news.filter((n) => th.keywords.some((k) => n.title.includes(k)));
    return {
      id: th.id,
      title: th.title,
      hitCount: hits.length,
      headlines: hits.slice(0, 3).map((n) => ({ title: n.title, src: n.src, time: n.time, url: n.url, channel: n.channel })),
      impacts: th.impacts,
      sampleKeyword: hits.length ? th.keywords.find((k) => hits[0].title.includes(k)) : null,
    };
  }).filter((x) => x.hitCount > 0)
    .sort((a, b) => b.hitCount - a.hitCount);

  const riskOffCount = themes.filter((x) => RISK_OFF.includes(x.id)).reduce((k, x) => k + x.hitCount, 0);
  const riskOnCount = themes.filter((x) => RISK_ON.includes(x.id)).reduce((k, x) => k + x.hitCount, 0);
  let tone = '中性';
  let toneNote = '国际主题分布均衡，未呈现明显的避险或 risk-on 倾向。';
  if (riskOffCount >= riskOnCount + 3) { tone = '避险升温'; toneNote = '地缘与贸易类主题的报道密度明显偏高，市场可能偏向避险资产（黄金 / 美元 / 债券）。'; }
  else if (riskOnCount >= riskOffCount + 3) { tone = '风险偏好回升'; toneNote = '政策与经济类主题占优，风险资产（股市 / 商品）关注度上升。'; }

  return {
    updatedAt: new Date().toISOString(),
    snapshot,
    newsTotal: news.length,
    news: news.slice(0, 30),
    themes,
    themeCount: themes.length,
    tone: { label: tone, note: toneNote, riskOffCount, riskOnCount },
    engineNote: '影响分析由关键词规则引擎生成：命中主题 → 给出资产方向映射，并引用命中的真实新闻标题。方向为该主题下的一般性市场关联，非对具体行情的预测。',
    source: '腾讯自选股数据接口（美股 / 港股 / 汇率品种资讯 + 热闻榜国际条目）',
    disclaimer: '国际形势分析为规则化初筛与背景梳理，不构成任何投资建议；地缘与政策事件的实际影响以市场走势与官方信息为准。',
  };
}

module.exports = { worldDesk, THEMES };
