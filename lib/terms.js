'use strict';
/**
 * terms.js — 统一术语索引（全站术语跳转的单一数据源）
 *
 * 维护方式（唯一入口）：
 *   1. 术语本体：在 `lib/appendix.js` 的第一部分「术语解释」（A.x.y）中新增 / 修改条目，
 *      字段为 no / term / en / meaning / scene。这是**唯一权威来源**。
 *   2. 匹配别名：本文件 `EXTRA_ALIASES` 按条目编号补充简称与别称（如 A.2.1 → PE、市盈率）。
 *      术语名（term）与英文名（en）会**自动生成**为别名，无需重复登记。
 *   3. 前端通过 `GET /api/terms` 拉取索引并自动标注正文，**无需改动任何视图代码**。
 *
 * 冲突处理：同一别名若对应多个条目会被丢弃并计入 `dropped`（避免跳转歧义），
 * 匹配时按别名长度降序做最长匹配（"涨跌幅" 优先于 "涨跌"）。
 */

const APPENDIX = require('./appendix').APPENDIX;

/**
 * 别名补充表：key = 条目编号，value = 额外匹配词
 * 仅在正文里确实会以这种形式出现时才登记，避免噪音标注。
 */
const EXTRA_ALIASES = {
  'A.1.4': ['涨跌'],
  'A.1.5': ['成交额', '成交量'],
  'A.1.6': ['换手'],
  'A.1.9': ['涨停', '跌停'],
  'A.1.13': ['总市值', '流通市值', '市值'],
  'A.2.1': ['PE', '市盈率'],
  'A.2.2': ['PB', '市净率'],
  'A.2.3': ['PS', '市销率'],
  'A.2.4': ['PCF', '市现率'],
  'A.2.5': ['股息率', '分红率'],
  'A.3.1': ['均线', 'MA5', 'MA10', 'MA20', 'MA60', 'MA120', 'MA250'],
  'A.3.5': ['MACD'],
  'A.3.6': ['金叉', '死叉'],
  'A.3.7': ['RSI'],
  'A.3.9': ['KDJ'],
  'A.3.10': ['BOLL', '布林带'],
  'A.3.12': ['波动率'],
  'A.3.13': ['最大回撤', '回撤'],
  'A.4.1': ['营业收入', '营收'],
  'A.4.4': ['净利润', '归母净利'],
  'A.4.5': ['EPS', '每股收益'],
  'A.4.6': ['毛利率'],
  'A.4.7': ['净利率'],
  'A.4.8': ['ROE', '净资产收益率'],
  'A.4.9': ['ROA'],
  'A.4.10': ['资产负债率', '负债率'],
  'A.4.13': ['经营现金流'],
  'A.5.1': ['主力净流入', '主力资金'],
  'A.5.8': ['北向资金', '陆股通'],
  'A.5.9': ['龙虎榜'],
  'A.5.10': ['两融', '融资融券'],
  'A.7.3': ['TTM'],
  'A.7.1': ['累计口径'],
  'A.7.2': ['单季'],
};

/** 过短的别名容易误伤正文（如单字母），统一下限 2 个字符 */
const MIN_ALIAS_LEN = 2;

/**
 * 从术语名派生别名。规则保守，避免产生带残括号的碎片：
 *   - 完整术语名本身
 *   - 无括号时按 " / " 拆分（"现价 / 最新价" → 现价、最新价）
 *   - 尾部括号：取括号内内容（"PE(TTM)" → TTM）与括号前主干（→ PE）
 *   - 括号内的英文编号 token（"RSI 相对强弱指标（RSI6 / RSI12）" → RSI6、RSI12）
 *   - 英文名（仅当为纯 ASCII 且长度 ≥3）
 */
function deriveAliases(item) {
  const out = new Set();
  const term = String(item.term || '').trim();
  if (term.length >= MIN_ALIAS_LEN) out.add(term);

  const hasBracket = /[（(]/.test(term) && /[）)]/.test(term);
  if (!hasBracket) {
    term.split(/\s*\/\s*/).forEach((p) => {
      const s = p.trim();
      if (s.length >= MIN_ALIAS_LEN) out.add(s);
    });
  } else {
    // 括号内英文编号：RSI6 / MA20 / RSI12
    const innerText = (term.match(/[（(]([^）)]*)[）)]/g) || []).join(' ');
    (innerText.match(/[A-Za-z]{2,}\d+/g) || []).forEach((t) => {
      if (t.length >= MIN_ALIAS_LEN) out.add(t);
    });
    const m = term.match(/^([^（(]+)[（(]([^）)]*)[）)]\s*$/);
    if (m) {
      const head = m[1].trim();
      const inner = m[2].trim();
      if (head.length >= MIN_ALIAS_LEN) out.add(head);
      if (inner.length >= MIN_ALIAS_LEN && /^[A-Za-z0-9]{2,}$/.test(inner)) out.add(inner);
    }
  }
  // 术语名中的英文缩写 token（PE、ROE、MA5…）
  (term.match(/\b[A-Za-z]{2,}\d*\b/g) || []).forEach((t) => {
    if (t.length >= MIN_ALIAS_LEN) out.add(t);
  });
  const en = String(item.en || '').trim();
  if (en.length >= 3 && /^[A-Za-z0-9()\-\s.]{3,40}$/.test(en)) out.add(en);
  return out;
}

/**
 * 构建术语索引。
 * @returns {{generatedAt:string,total:number,terms:Array,dropped:Array}}
 */
function buildTermIndex() {
  const partA = (APPENDIX.parts || []).find((p) => p.no === 'A');
  const groups = partA ? (partA.categories || partA.groups || []) : [];

  const terms = [];
  const owner = new Map();      // 别名 → 条目编号
  const dropped = [];
  const items = [];
  groups.forEach((g) => (g.items || []).forEach((it) => items.push({ it, category: g.title })));

  /** 登记别名；被别的条目占用则丢弃（保持跳转唯一、无歧义） */
  const claim = (alias, no) => {
    const prev = owner.get(alias);
    if (prev && prev !== no) { dropped.push({ alias, keep: prev, drop: no }); return false; }
    owner.set(alias, no);
    return true;
  };

  // 第一遍：显式别名优先（EXTRA_ALIASES 是人工维护的，可信度最高）
  items.forEach(({ it }) => {
    (EXTRA_ALIASES[it.no] || []).forEach((a) => {
      if (String(a).length >= MIN_ALIAS_LEN) claim(String(a), it.no);
    });
  });
  // 第二遍：派生别名（术语名 / 英文名），已被占用则跳过
  items.forEach(({ it }) => { deriveAliases(it).forEach((a) => { if (a.length >= MIN_ALIAS_LEN) claim(a, it.no); }); });

  items.forEach(({ it, category }) => {
    // 最长优先匹配
    const kept = [...owner.entries()].filter(([, no]) => no === it.no).map(([a]) => a);
    kept.sort((x, y) => y.length - x.length);
    terms.push({
      no: it.no,
      term: it.term,
      en: it.en || '',
      category,
      scene: it.scene || '',
      aliases: kept,
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    total: terms.length,
    terms,
    dropped,
    maintenance: '术语本体维护于 lib/appendix.js（A 部分条目）；别名维护于 lib/terms.js 的 EXTRA_ALIASES；前端经 GET /api/terms 自动同步。',
  };
}

module.exports = { buildTermIndex, EXTRA_ALIASES, MIN_ALIAS_LEN };
