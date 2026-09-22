'use strict';
/**
 * hk-mock.js — 港股板块模拟数据（占位）
 *
 * ⚠️ 本文件为模拟数据源，字段结构与真实数据完全一致，便于后续整体替换：
 *   - 行情字段与 catalog.js fetchQuotes() 的输出形状相同：
 *     { name, market, price, changePct, change, turnoverRate, pe, pb, marketCap(亿元) }
 *   - 列表行与其它维度相同：{ code, name, extra }
 *   - 代码采用带市场前缀的规范形态（hkXXXXX），与 westock 各接口一致，
 *     因此「点击股票 → 财报整理」等跨模块跳转在模拟阶段即可真实工作。
 *
 * 替换为真实数据时（三步，详见模块底部注释）：
 *   1. 用真实成分股清单替换 hkLoader 的返回（如港股通标的 / 恒指成分）；
 *   2. 删除返回值中的 quotes 字段（置空），让 catalog.js 走 fetchQuotes(hkXXXXX) 拉取真实行情
 *      —— 已实测 westock quote/finance/kline 均支持 hk 前缀代码；
 *   3. 移除返回值中的 mock 标记与前端提示。
 */

/** 模拟行情基础价（HKD）；涨跌幅每日随机微调，保证刷新可见但不失真 */
const HK_STOCKS = [
  // ---- 恒生指数成分（蓝筹） ----
  { code: 'hk00700', name: '腾讯控股', group: 'hsi', price: 452.0, chg: 4.65, turnoverRate: 0.21, pe: 22.8, pb: 4.6, cap: 41800 },
  { code: 'hk00388', name: '香港交易所', group: 'hsi', price: 318.4, chg: -1.12, turnoverRate: 0.35, pe: 38.2, pb: 9.1, cap: 4050 },
  { code: 'hk00005', name: '汇丰控股', group: 'hsi', price: 71.85, chg: 0.63, turnoverRate: 0.28, pe: 7.4, pb: 0.9, cap: 13200 },
  { code: 'hk01299', name: '友邦保险', group: 'hsi', price: 62.30, chg: -0.48, turnoverRate: 0.19, pe: 14.1, pb: 1.8, cap: 7350 },
  { code: 'hk00941', name: '中国移动', group: 'hsi', price: 78.55, chg: 1.02, turnoverRate: 0.24, pe: 10.6, pb: 1.1, cap: 16800 },
  { code: 'hk03988', name: '中国银行', group: 'hsi', price: 4.36, chg: 0.46, turnoverRate: 0.31, pe: 5.1, pb: 0.5, cap: 12200 },
  { code: 'hk01398', name: '工商银行', group: 'hsi', price: 5.62, chg: 0.36, turnoverRate: 0.27, pe: 5.3, pb: 0.5, cap: 20000 },
  { code: 'hk00883', name: '中国海洋石油', group: 'hsi', price: 19.78, chg: 2.06, turnoverRate: 0.42, pe: 7.2, pb: 1.2, cap: 9400 },
  { code: 'hk00386', name: '中国石油化工股份', group: 'hsi', price: 4.28, chg: -0.70, turnoverRate: 0.18, pe: 8.0, pb: 0.6, cap: 5200 },
  { code: 'hk00939', name: '建设银行', group: 'hsi', price: 6.44, chg: 0.31, turnoverRate: 0.22, pe: 5.0, pb: 0.5, cap: 16100 },
  { code: 'hk02318', name: '中国平安', group: 'hsi', price: 54.10, chg: 1.19, turnoverRate: 0.55, pe: 8.8, pb: 1.0, cap: 9900 },
  { code: 'hk01088', name: '中国神华', group: 'hsi', price: 33.15, chg: 0.91, turnoverRate: 0.16, pe: 9.5, pb: 1.3, cap: 6600 },
  // ---- 恒生科技指数 ----
  { code: 'hk09988', name: '阿里巴巴-W', group: 'hstech', price: 113.6, chg: 0.18, turnoverRate: 0.86, pe: 17.9, pb: 1.6, cap: 21800 },
  { code: 'hk03690', name: '美团-W', group: 'hstech', price: 128.9, chg: -2.24, turnoverRate: 0.93, pe: 26.5, pb: 3.4, cap: 7900 },
  { code: 'hk01810', name: '小米集团-W', group: 'hstech', price: 22.15, chg: 3.28, turnoverRate: 1.24, pe: 28.7, pb: 3.9, cap: 5530 },
  { code: 'hk09618', name: '京东集团-SW', group: 'hstech', price: 132.8, chg: -0.85, turnoverRate: 0.71, pe: 13.6, pb: 1.4, cap: 4100 },
  { code: 'hk09999', name: '网易-S', group: 'hstech', price: 172.3, chg: 1.36, turnoverRate: 0.44, pe: 19.4, pb: 3.1, cap: 5580 },
  { code: 'hk09888', name: '百度集团-SW', group: 'hstech', price: 92.75, chg: -1.67, turnoverRate: 0.62, pe: 11.2, pb: 0.9, cap: 2580 },
  { code: 'hk01024', name: '快手-W', group: 'hstech', price: 58.35, chg: 2.46, turnoverRate: 1.05, pe: 21.0, pb: 3.6, cap: 2520 },
  { code: 'hk00285', name: '比亚迪电子', group: 'hstech', price: 33.70, chg: 4.12, turnoverRate: 1.88, pe: 24.3, pb: 3.0, cap: 760 },
  // ---- 其他常见标的（仅归入「全部样本」） ----
  { code: 'hk02020', name: '安踏体育', group: 'other', price: 84.55, chg: -0.94, turnoverRate: 0.38, pe: 21.6, pb: 5.7, cap: 2320 },
  { code: 'hk01876', name: '百威亚太', group: 'other', price: 8.93, chg: 0.45, turnoverRate: 0.14, pe: 32.8, pb: 2.1, cap: 1180 },
  { code: 'hk00669', name: '创科实业', group: 'other', price: 108.9, chg: 1.73, turnoverRate: 0.29, pe: 16.4, pb: 3.8, cap: 1990 },
  { code: 'hk00291', name: '华润啤酒', group: 'other', price: 28.60, chg: -1.21, turnoverRate: 0.21, pe: 25.1, pb: 2.9, cap: 930 },
];

/** 模拟行情：以基准价做日内微小的伪随机漂移，让「刷新」可感知（幅度 ±0.6% 内） */
function mockQuote(s) {
  const seed = Number(String(Date.now()).slice(-6)) + s.code.split('').reduce((k, c) => k + c.charCodeAt(0), 0);
  const drift = ((seed % 13) - 6) / 1000;                        // -0.6% ~ +0.6%
  const price = Math.round(s.price * (1 + drift) * 100) / 100;
  const changePct = Math.round((s.chg + drift * 100) * 100) / 100;
  const prevClose = Math.round((price / (1 + changePct / 100)) * 100) / 100;
  return {
    name: s.name,
    market: '港股',
    price,
    change: Math.round((price - prevClose) * 100) / 100,
    changePct,
    turnoverRate: s.turnoverRate,
    pe: s.pe,
    pb: s.pb,
    marketCap: s.cap,                                            // 单位：亿元（与 fetchQuotes 归一化后一致）
  };
}

/** 分类定义（与 connect / watch 等双组维度同构） */
const HK_GROUPS = [
  { code: 'hsi', name: '恒生指数成分（模拟）', subtitle: '蓝筹样本 · 模拟数据' },
  { code: 'hstech', name: '恒生科技（模拟）', subtitle: '科技样本 · 模拟数据' },
  { code: 'all', name: '全部样本（模拟）', subtitle: '含其他常见标的 · 模拟数据' },
];

/**
 * 港股板块加载器 —— 与 LOADERS 其它成员同构：
 * 返回 { title, list: [{code, name, extra}], quotes, mock, note }
 * quotes 提供时 catalog.js 会跳过真实行情拉取（替换真实数据时置空即可）。
 */
async function hkLoader(code) {
  const key = HK_GROUPS.some((g) => g.code === code) ? code : 'all';
  const rows = key === 'all' ? HK_STOCKS : HK_STOCKS.filter((s) => s.group === key);
  const group = HK_GROUPS.find((g) => g.code === key);
  return {
    title: `${group.name.replace('（模拟）', '')} · 模拟数据`,
    mock: true,
    note: '港股板块当前为模拟数据（字段结构与真实数据一致），仅用于展示与交互验证；行情、估值均非真实值，点击股票跳转的财报为该股真实财报数据。',
    list: rows.map((s) => ({ code: s.code, name: s.name, extra: {} })),
    quotes: Object.fromEntries(rows.map((s) => [s.code, mockQuote(s)])),
  };
}

module.exports = { hkLoader, HK_GROUPS, HK_STOCKS };

/**
 * —— 真实数据替换指引 ——
 * 已实测 westock 对港股支持完整（代码形态 hkXXXXX）：
 *   westock quote hk00700        → 实时行情（价格/涨跌幅/换手率/市值，市值单位为元，fetchQuotes 已归一化）
 *   westock finance hk00700      → 三大报表（点击股票 → 财报整理 现已可用）
 *   westock kline hk00700        → 日 K
 * 替换步骤：
 *   1) 在 LOADERS 增加真实成分股来源（如港股通名单 / 恒指成分），返回 {code, name, extra}；
 *   2) 去掉返回值中的 quotes 与 mock 字段 → catalog.js 自动改走 fetchQuotes(codes) 拉真实行情；
 *   3) 移除 HK_GROUPS 名称中的「（模拟）」字样与 stocks.js 的模拟提示条。
 */
