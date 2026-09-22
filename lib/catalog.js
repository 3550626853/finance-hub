'use strict';
/**
 * catalog.js — 股票列表模块
 * 按「宽基指数 / 申万一级行业 / 热门概念」三个维度对全市场股票分类，
 * 每个分类下给出成分股的名称、代码、当前价与涨跌幅。
 * 数据源：westock（index constituent / sector constituent / sector ranking / quote）
 */

const W = require('./westock');
const A = require('./analytics');
const HK_MOCK = require('./hk-mock');

// 申万一级行业（2021 版，31 个）——合计覆盖全部 A 股
const SW_L1 = [
  { code: 'pt01801010', name: '农林牧渔' },
  { code: 'pt01801030', name: '基础化工' },
  { code: 'pt01801040', name: '钢铁' },
  { code: 'pt01801050', name: '有色金属' },
  { code: 'pt01801080', name: '电子' },
  { code: 'pt01801110', name: '家用电器' },
  { code: 'pt01801120', name: '食品饮料' },
  { code: 'pt01801130', name: '纺织服饰' },
  { code: 'pt01801140', name: '轻工制造' },
  { code: 'pt01801150', name: '医药生物' },
  { code: 'pt01801160', name: '公用事业' },
  { code: 'pt01801170', name: '交通运输' },
  { code: 'pt01801180', name: '房地产' },
  { code: 'pt01801200', name: '商贸零售' },
  { code: 'pt01801210', name: '社会服务' },
  { code: 'pt01801230', name: '综合' },
  { code: 'pt01801710', name: '建筑材料' },
  { code: 'pt01801720', name: '建筑装饰' },
  { code: 'pt01801730', name: '电力设备' },
  { code: 'pt01801740', name: '国防军工' },
  { code: 'pt01801750', name: '计算机' },
  { code: 'pt01801760', name: '传媒' },
  { code: 'pt01801770', name: '通信' },
  { code: 'pt01801780', name: '银行' },
  { code: 'pt01801790', name: '非银金融' },
  { code: 'pt01801880', name: '汽车' },
  { code: 'pt01801890', name: '机械设备' },
  { code: 'pt01801950', name: '煤炭' },
  { code: 'pt01801960', name: '石油石化' },
  { code: 'pt01801970', name: '环保' },
  { code: 'pt01801980', name: '美容护理' },
];

// 已验证可用的宽基指数（部分指数上游不提供成分股清单）
const INDEX_CATALOG = [
  { code: 'sh000300', name: '沪深300', desc: '大盘蓝筹' },
  { code: 'sh000016', name: '上证50', desc: '超大盘龙头' },
  { code: 'sh000688', name: '科创50', desc: '科创板龙头' },
  { code: 'bj899050', name: '北证50', desc: '北交所龙头' },
];

const GROUP_LIMIT = 40;          // 概念板块展示数量
const QUOTE_CHUNK = 100;         // 单次批量行情代码数
const CONNECT_LIMIT = 2000;      // 沪深港通标的拉取上限（沪股通约 1600+）
const LIST_CAP = 2000;           // 单一分类最多处理的成分股数

const clean = (v) => (v === '--' || v === '-' || v === '' ? null : v);

/** 从表格标题行里抽出成分股数量，如 "…（519 只）" */
function parseCount(title) {
  const m = /\((\d+)\s*只\)/.exec(String(title || ''));
  return m ? Number(m[1]) : null;
}

/**
 * 各分类维度的成分股来源。
 * 返回统一结构：{ title, list: [{code, name, extra}] }
 */
const LOADERS = {
  // 申万一级 / 二级行业、概念板块：均为板块代码
  sector: async (code) => {
    const res = await W.sectorConstituent(code);
    const t = res.tables[0];
    return {
      title: t ? t.title : code,
      list: (t ? t.rows : []).map((r) => ({ code: clean(r.code), name: clean(r.name), extra: {} })),
    };
  },
  // 宽基指数成分股
  index: async (code) => {
    const res = await W.indexConstituent(code);
    const t = res.tables[0];
    return {
      title: t ? t.title : code,
      list: (t ? t.rows : []).map((r) => ({ code: clean(r.code), name: clean(r.name), extra: {} })),
    };
  },
  // 沪深港通标的（陆股通）：code = 'sh' | 'sz'
  connect: async (code) => {
    const res = await W.connect(code, CONNECT_LIMIT, 0);
    const t = res.tables[0];
    const totalM = /共\s*(\d+)\s*只/.exec(res.text);
    return {
      title: code === 'sz' ? '深股通标的（陆股通）' : '沪股通标的（陆股通）',
      declaredTotal: totalM ? Number(totalM[1]) : null,
      list: (t ? t.rows : []).map((r) => ({ code: clean(r.code), name: clean(r.name), extra: {} })),
    };
  },
  // 热搜股票池
  hot: async () => {
    const res = await W.hot('stock', 50);
    const t = res.tables[0];
    return {
      title: '热搜股票池（腾讯自选股热度榜）',
      list: (t ? t.rows : []).map((r) => ({
        code: clean(r.code), name: clean(r.name),
        extra: { heatChangePct: W.toNum(r.zdf), heatPrice: W.toNum(r.zxj) },
      })),
    };
  },
  // 当日龙虎榜
  lhb: async () => {
    const res = await W.lhb('all');
    const t = res.tables[0];
    return {
      title: t ? t.title : '全市场龙虎榜',
      list: (t ? t.rows : []).map((r) => ({
        code: clean(r.code), name: clean(r.name),
        extra: {
          lhbRank: W.toNum(r.rank), lhbNetBuy: W.toNum(r.netBuyAmount),
          lhbBuy: W.toNum(r.buyAmount), lhbSell: W.toNum(r.sellAmount),
        },
      })),
    };
  },
  // 港股板块（当前为模拟数据，替换指引见 lib/hk-mock.js 底部注释）
  hk: HK_MOCK.hkLoader,
};

/** 维度 key → 加载器 */
const DIM_SOURCE = {
  index: 'index', industry: 'sector', industry2: 'sector', concept: 'sector',
  connect: 'connect', watch: 'lhb', hk: 'hk',
};

/** 分批拉取实时行情，返回 code → {price, changePct, ...} */
async function fetchQuotes(codes) {
  const map = {};
  const chunks = [];
  for (let i = 0; i < codes.length; i += QUOTE_CHUNK) chunks.push(codes.slice(i, i + QUOTE_CHUNK));
  const results = await Promise.allSettled(chunks.map((c) => W.quote(c)));
  results.forEach((r) => {
    if (r.status !== 'fulfilled') return;
    (r.value.rows || []).forEach((row) => {
      const code = clean(row.code);
      if (!code) return;
      map[code] = {
        name: clean(row.name) || code,
        market: clean(row.market_name),
        price: W.toNum(row.price),
        changePct: W.toNum(row.change_percent),
        change: W.toNum(row.change),
        turnoverRate: W.toNum(row.turnover_rate),
        volumeRatio: W.toNum(row.volume_ratio),
        amount: W.toNum(row.amount),
        pe: W.toNum(row.pe_ratio),
        pb: W.toNum(row.pb_ratio),
        // 总市值：数据源单位在「元 / 亿元」间漂移（详见 analytics.normCap），自适应归一化为亿元
        marketCap: A.normCap(row.total_market_cap),
      };
    });
  });
  return map;
}

/** 分类目录：多个维度及各自的分组清单 */
async function stockCatalog() {
  const [industryRank, conceptRank] = await Promise.all([
    W.sectorRanking({ kind: 'industry', type: 'changePct', order: 'desc' }).catch(() => ({ rows: [] })),
    W.sectorRanking({ kind: 'concept', type: 'changePct', order: 'desc' }).catch(() => ({ rows: [] })),
  ]);

  const l1Names = new Set(SW_L1.map((x) => x.name));
  const allIndustry = (industryRank.rows || []).map((r) => ({
    code: clean(r.code), name: clean(r.name),
    changePct: W.toNum(r.changePct), upCount: clean(r.upCount), leader: clean(r.leader),
  })).filter((x) => x.code && x.name);

  // 申万二级 = 行业榜中排除掉一级行业后的部分（上游行业榜为 124 个二级行业）
  const l2 = allIndustry.filter((x) => !l1Names.has(x.name));

  // 涨跌幅映射（用于一级行业副标题）
  const rankMap = {};
  allIndustry.forEach((x) => { rankMap[x.name] = x; });

  const conceptRows = (conceptRank.rows || []).slice(0, GROUP_LIMIT).map((r, i) => ({
    code: clean(r.code), name: clean(r.name),
    changePct: W.toNum(r.changePct), rank: i + 1,
    upCount: clean(r.upCount), leader: clean(r.leader),
  })).filter((x) => x.code && x.name);

  return {
    updatedAt: new Date().toISOString(),
    quoteChunk: QUOTE_CHUNK,
    dimensions: [
      {
        key: 'index',
        label: '宽基指数',
        hint: '按市场规模与板块划分的代表性指数成分股',
        groups: INDEX_CATALOG.map((x) => ({ ...x, subtitle: x.desc })),
      },
      {
        key: 'industry',
        label: '申万一级行业',
        hint: '31 个一级行业，合计覆盖全部 A 股',
        groups: SW_L1.map((x) => ({
          ...x,
          subtitle: rankMap[x.name] ? `行业涨跌 ${rankMap[x.name].changePct >= 0 ? '+' : ''}${rankMap[x.name].changePct}%` : null,
          changePct: rankMap[x.name] ? rankMap[x.name].changePct : null,
        })),
      },
      {
        key: 'industry2',
        label: '申万二级行业',
        hint: `更细粒度的行业划分，共 ${l2.length} 个（按今日涨幅排序）`,
        groups: l2.map((x) => ({
          code: x.code, name: x.name,
          subtitle: x.leader ? `领涨 ${x.leader}` : null,
          changePct: x.changePct,
        })),
      },
      {
        key: 'concept',
        label: '热门概念',
        hint: '按概念板块今日涨幅排序',
        groups: conceptRows.map((x) => ({
          code: x.code, name: x.name,
          subtitle: x.leader ? `领涨 ${x.leader}` : null,
          changePct: x.changePct,
          upCount: x.upCount,
        })),
      },
      {
        key: 'connect',
        label: '沪深港通标的',
        hint: '陆股通（北向资金）可交易标的范围，分沪股通与深股通',
        groups: [
          { code: 'sh', name: '沪股通标的', subtitle: '上海市场陆股通标的' },
          { code: 'sz', name: '深股通标的', subtitle: '深圳市场陆股通标的' },
        ],
      },
      {
        key: 'hk',
        label: '港股',
        hint: '港股样本分类（当前为模拟数据，字段结构与真实数据一致，便于接入真实行情）',
        groups: HK_MOCK.HK_GROUPS.map((g) => ({ ...g })),
      },
      {
        key: 'watch',
        label: '热门榜单',
        hint: '按当日龙虎榜与市场热度筛选的活跃标的',
        groups: [
          { code: 'lhb', name: '当日龙虎榜', subtitle: '交易所公布的异动成交明细股' },
          { code: 'hot', name: '热搜股票池', subtitle: '按用户关注热度排序' },
        ],
      },
    ],
  };
}

/** 某个分类下的成分股列表（含实时行情） */
async function stockListByCategory({ kind = 'industry', code, q = '', sort = 'changePct', order = 'desc', limit = 60, offset = 0 } = {}) {
  if (!code) throw Object.assign(new Error('缺少分类代码'), { code: 'BAD_PARAM' });

  // 热门榜单维度的 code 即加载器名（lhb / hot）
  const source = kind === 'watch' ? code : (DIM_SOURCE[kind] || 'sector');
  const loader = LOADERS[source];
  if (!loader) throw Object.assign(new Error(`未知分类维度：${kind}`), { code: 'BAD_PARAM' });

  const res = await loader(code);
  let rawRows = res.list || [];
  rawRows = rawRows.slice(0, LIST_CAP);

  const codes = rawRows.map((r) => r.code).filter(Boolean);
  // 加载器自带行情（模拟数据场景）时直接使用，跳过真实行情拉取
  const quotes = res.quotes || await fetchQuotes(codes);

  let list = rawRows.map((r) => {
    const qq = quotes[r.code] || {};
    return {
      code: r.code,
      name: r.name || qq.name || r.code,
      market: qq.market || null,
      price: qq.price === undefined ? null : qq.price,
      changePct: qq.changePct === undefined ? null : qq.changePct,
      turnoverRate: qq.turnoverRate === undefined ? null : qq.turnoverRate,
      pe: qq.pe === undefined ? null : qq.pe,
      pb: qq.pb === undefined ? null : qq.pb,
      marketCap: qq.marketCap === undefined ? null : qq.marketCap,
      extra: r.extra || {},
    };
  });

  if (q) {
    const k = String(q).trim().toLowerCase();
    list = list.filter((x) => String(x.name).toLowerCase().includes(k) || String(x.code).toLowerCase().includes(k));
  }

  const dir = order === 'asc' ? 1 : -1;
  const numOr = (v) => (v === null || v === undefined ? -Infinity : v);
  if (sort === 'name') list.sort((a, b) => dir * String(a.name).localeCompare(String(b.name), 'zh'));
  else if (sort === 'code') list.sort((a, b) => dir * String(a.code).localeCompare(String(b.code)));
  else list.sort((a, b) => dir * (numOr(a[sort]) - numOr(b[sort])));

  const total = list.length;
  const page = list.slice(offset, offset + limit);

  const changes = list.map((x) => x.changePct).filter((x) => x !== null);
  const up = changes.filter((x) => x > 0).length;
  const down = changes.filter((x) => x < 0).length;

  return {
    kind, code,
    title: res.title || code,
    name: (String(res.title || '').match(/成分股[-－]([^\s\[]+)/) || [])[1] || (res.title || code),
    declaredCount: res.declaredTotal !== undefined ? res.declaredTotal : parseCount(res.title),
    collected: rawRows.length,
    updatedAt: new Date().toISOString(),
    total,
    offset, limit,
    list: page,
    // 模拟数据标记（港股板块当前为占位数据，见 lib/hk-mock.js）
    mock: !!res.mock,
    note: res.note || null,
    stats: {
      up, down, flat: changes.length - up - down,
      avgChangePct: changes.length ? A.round(A.mean(changes), 2) : null,
      medianChangePct: changes.length ? A.round(A.median(changes), 2) : null,
      limitUp: changes.filter((x) => x >= 9.8).length,
      priceAvailable: changes.length,
    },
  };
}

module.exports = { stockCatalog, stockListByCategory, SW_L1, INDEX_CATALOG, fetchQuotes };
