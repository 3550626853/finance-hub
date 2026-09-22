'use strict';
/**
 * westock.js — 数据接入层
 * 封装 westock CLI（腾讯自选股数据接口），把 Markdown 表格输出解析为结构化 JSON。
 * 所有金融数据均来自此单一数据源。
 */

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

/** 解析 westock 可执行文件位置 */
function resolveBin() {
  if (process.env.WESTOCK_BIN) return process.env.WESTOCK_BIN;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'westock.exe'),
    path.join(os.homedir(), '.local', 'bin', 'westock'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return 'westock';
}

const WESTOCK_BIN = resolveBin();

/** 带互斥的并发闸门，避免瞬时打爆上游 */
class Gate {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  run(fn) {
    return new Promise((resolve, reject) => {
      const task = () => {
        this.active++;
        Promise.resolve().then(fn).then(
          (v) => { this.active--; this._next(); resolve(v); },
          (e) => { this.active--; this._next(); reject(e); }
        );
      };
      if (this.active < this.limit) task(); else this.queue.push(task);
    });
  }
  _next() { const t = this.queue.shift(); if (t) t(); }
}
const gate = new Gate(6);

/** 调用 CLI，返回原始文本 */
function raw(args, { timeout = 45000 } = {}) {
  return gate.run(() => new Promise((resolve, reject) => {
    execFile(WESTOCK_BIN, args, {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: process.env,
    }, (err, stdout, stderr) => {
      const out = (stdout || '').toString();
      const errOut = (stderr || '').toString();
      if (!out.trim() && err) {
        const e = new Error(`westock ${args.join(' ')} 失败: ${errOut.trim() || err.message}`);
        e.code = 'CLI_FAIL';
        return reject(e);
      }
      resolve({ text: out, stderr: errOut });
    });
  }));
}

// ---------- Markdown 表格解析 ----------

const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;

function cleanCell(s) {
  return String(s == null ? '' : s)
    .replace(MD_LINK, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function isRow(line) {
  const t = line.trim();
  return t.startsWith('|') && t.length > 1;
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(cleanCell);
}

function isSeparator(line) {
  if (!isRow(line)) return false;
  const cells = splitRow(line);
  if (!cells.length) return false;
  return cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c));
}

const NUMERIC_CELL = /^-?[\d,]+(\.\d+)?%?$/;

/**
 * 由表头名推断列的「形状约束」，用于在合并候选之间做取舍。
 * 只收录形状极其确定的几类列（URL / 时间戳 / 排名 / 代码），避免误判。
 */
const COL_HINT = [
  { re: /url|link|链接/i, ok: (v) => /^https?:\/\//i.test(v) },
  { re: /(^|_)(time|ts|date)(_|$)|时间|日期/i, ok: (v) => /^\d{9,}$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v) },
  { re: /rank|^#$|序号|排名|名次/i, ok: (v) => NUMERIC_CELL.test(v) },
  { re: /(^|_)id$|^id$|代码|编号/i, ok: (v) => v.length > 0 && !/\s/.test(v) },
];

function buildColHints(header) {
  return header.map((h) => {
    const hit = COL_HINT.find((c) => c.re.test(String(h || '')));
    return hit ? hit.ok : null;
  });
}

/**
 * 推断哪些列是「数值列」：只用**列数规整**的行做统计，
 * 避免被含 `|` 的脏行污染判断。
 */
function inferNumericCols(rows, m) {
  const flags = new Array(m).fill(false);
  for (let j = 0; j < m; j++) {
    let tot = 0; let num = 0;
    rows.forEach((r) => {
      if (r.length !== m) return;
      const v = String(r[j] == null ? '' : r[j]).trim();
      if (!v || v === '--' || v === '-') return;
      tot++;
      if (NUMERIC_CELL.test(v)) num++;
    });
    flags[j] = tot >= 2 && num / tot >= 0.7;
  }
  return flags;
}

/**
 * 修复「单元格内含 `|`」导致的列数超出：
 * 正文里出现裸竖线（如新闻标题 `利好利空晚报|xxx`）会把一行拆成多余单元格，
 * 后续所有列整体错位（表现为标题被截断、来源变成时间戳）。
 * 做法：每轮把**相邻两个**单元格合并回一个（一轮消化一个多余的竖线），
 * 判据依次为「数值列仍为数值 + 表头形状约束（URL/时间/排名/代码）」罚分最低 →
 * 优先继续合并已含竖线的单元格 → 合并内容更长。
 * 多列同时含竖线时循环处理即可全部还原。
 */
function repairRow(cells, m, numericCols, colHints) {
  const hints = colHints || [];
  const penaltyOf = (out, mergedIdx) => {
    let penalty = 0;
    for (let j = 0; j < m; j++) {
      if (j === mergedIdx) continue;
      const v = String(out[j] == null ? '' : out[j]).trim();
      if (!v) continue;
      if (numericCols[j] && !NUMERIC_CELL.test(v)) penalty++;
      if (hints[j] && !hints[j](v)) penalty++;
    }
    return penalty;
  };
  let cur = cells.slice();
  let guard = 0;
  while (cur.length > m && guard++ < 8) {
    let best = null;
    for (let p = 0; p + 1 < cur.length; p++) {
      const merged = `${cur[p]}|${cur[p + 1]}`;
      const out = cur.slice(0, p).concat([merged], cur.slice(p + 2));
      const penalty = penaltyOf(out, p);
      // 合并位置落在「形状约束列」（id/url/时间/排名）上属于可疑选择：
      // 被撑裂的几乎总是自由文本列，约束列极少包含竖线
      const hintMerge = !!(hints && hints[p]);
      // 原带竖线的单元格优先继续合并（避免把两个本来正常的列粘在一起）
      const carries = (String(cur[p]).includes('|') ? 1 : 0) + (String(cur[p + 1]).includes('|') ? 1 : 0);
      const cand = { out, penalty, hintMerge, carries, len: merged.length };
      if (!best
        || cand.penalty < best.penalty
        || (cand.penalty === best.penalty && cand.hintMerge < best.hintMerge)
        || (cand.penalty === best.penalty && cand.hintMerge === best.hintMerge && cand.carries > best.carries)
        || (cand.penalty === best.penalty && cand.hintMerge === best.hintMerge && cand.carries === best.carries && cand.len > best.len)) best = cand;
    }
    if (!best) break;
    cur = best.out;
  }
  return cur.length > m ? cells.slice(0, m) : cur;
}

/** 把整段文本中的所有 Markdown 表格解析为对象数组，并带上最近的加粗小标题 */
function parseTables(text) {
  const lines = String(text || '').split(/\r?\n/);
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitRow(lines[i]);
      // 向上寻找最近的小标题
      let title = '';
      for (let k = i - 1; k >= 0; k--) {
        const t = lines[k].trim();
        if (!t) continue;
        if (isRow(t)) break;
        title = cleanCell(t).replace(/[:：]$/, '');
        break;
      }
      const raw = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) { raw.push(splitRow(lines[j])); j++; }
      // 列数超出表头的行 → 判定为「单元格内含竖线」，按列类型约束还原
      const numericCols = inferNumericCols(raw, header.length);
      const colHints = buildColHints(header);
      const rows = raw.map((r) => (r.length === header.length ? r : repairRow(r, header.length, numericCols, colHints)));
      const data = rows
        .filter((r) => r.some((c) => c !== ''))
        .map((r) => {
          const o = {};
          header.forEach((h, idx) => { o[h || `col${idx}`] = r[idx] !== undefined ? r[idx] : ''; });
          return o;
        });
      tables.push({ title, header, rows: data });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

// ---------- 数值工具 ----------

const NUM_KEYS_HINT = /^(price|change|percent|rate|ratio|eps|nav|amount|volume|vol|cap|value|pct|pe|pb|ps|roe|roa|roic|margin|income|revenue|profit|cost|cash|asset|liab|equity|share|debt|turnover|growth|yoy|qoq|ttm|sma|ema|rsi|macd|kdj|boll|atr|std|beta|score|weight|limit|count|index|open|high|low|close|last|prev|avg|min|max|total|net|gross|oper|invest|finance|free|working)/i;

function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, '').replace(/%$/, '').replace(/[¥$HK$]/g, '');
  if (!s || s === '--' || s === '-' || s === '—' || s === 'N/A' || s === 'null') return null;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 按字段名启发式地把数字字符串转为 number，保留原始字段名 */
function numify(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === '' || v === '--' || v === '-') { out[k] = null; continue; }
    if (NUM_KEYS_HINT.test(k)) {
      const n = toNum(v);
      out[k] = n === null ? v : n;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function numifyAll(rows) { return rows.map(numify); }

// ---------- 业务查询封装 ----------

const cache = new Map();
const TTL = {
  ipo: 5 * 60 * 1000,
  quote: 30 * 1000,
  kline: 60 * 1000,
  finance: 30 * 60 * 1000,
  sector: 3 * 60 * 1000,
  hot: 3 * 60 * 1000,
  search: 10 * 60 * 1000,
  news: 5 * 60 * 1000,
  generic: 2 * 60 * 1000,
};

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttl) { cache.set(key, { value, at: Date.now(), ttl }); }
function cacheClear(prefix) {
  if (!prefix) { const n = cache.size; cache.clear(); return n; }
  let n = 0;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) { cache.delete(k); n++; }
  return n;
}

/** 统一：带缓存的查询，返回 {tables, text, fetchedAt, cached}；bypass=true 时跳过缓存直接回源 */
async function query(args, { ttl = TTL.generic, cacheKey = null, timeout = 45000, bypass = false } = {}) {
  const key = cacheKey || args.join(' ');
  if (!bypass) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  let argv = args.slice();
  let lastErr = null;
  // 最多降级 3 次：某个子命令不支持某参数时，自动剔除该参数后重试
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { text, stderr } = await raw(argv, { timeout });
      const tables = parseTables(text);
      const value = {
        text,
        stderr: stderr ? stderr.trim().split('\n').slice(-3).join(' | ') : '',
        tables,
        rows: tables.length ? tables[0].rows : [],
        argv,
        fetchedAt: new Date().toISOString(),
      };
      cacheSet(key, value, ttl);
      return { ...value, cached: false };
    } catch (e) {
      lastErr = e;
      const m = /unknown flag:\s*(--?[\w-]+)/.exec(e.message || '');
      if (!m) throw e;
      const flag = m[1];
      const idx = argv.indexOf(flag);
      if (idx === -1) throw e;
      // --key value 形式需一并移除取值
      const drop = (idx + 1 < argv.length && !String(argv[idx + 1]).startsWith('-')) ? 2 : 1;
      argv.splice(idx, drop);
    }
  }
  throw lastErr;
}

const M = { hs: 'hs', hk: 'hk', us: 'us' };

module.exports = {
  WESTOCK_BIN,
  raw,
  parseTables,
  query,
  toNum,
  numify,
  numifyAll,
  cacheClear,
  TTL,
  M,
  // 供测试与调试：Markdown 表格「单元格含竖线」的修复逻辑
  _repairRow: repairRow,
  _inferNumericCols: inferNumericCols,
  _buildColHints: buildColHints,
  // 便捷方法
  ipo: (market = 'hs') => query(['ipo', '--market', market], { ttl: TTL.ipo, cacheKey: `ipo:${market}` }),
  quote: (codes) => query(['quote', [].concat(codes).join(',')], { ttl: TTL.quote, cacheKey: `quote:${[].concat(codes).join(',')}` }),
  kline: async (code, period = 'day', limit = 60) => {
    const res = await query(['kline', code, '--period', period, '--limit', String(limit)],
      { ttl: TTL.kline, cacheKey: `kline:${code}:${period}:${limit}` });
    // CLI 返回为倒序（最新在前），统一转为时间正序，指标计算依赖时间递增
    if (res.tables.length && res.tables[0].rows.length) {
      const rows = res.tables[0].rows
        .slice()
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      res.tables[0].rows = rows;
      res.rows = rows;
    }
    return res;
  },
  technical: (code) => query(['technical', code], { ttl: TTL.kline, cacheKey: `tech:${code}` }),
  /**
   * 技术指标批量查询。
   * 实测：`westock technical` 单次最多 10 个代码，第 11 个起整批返回 error（0 成功）。
   * 因此按 10 个一组分片并发查询，再合并结果集，避免"部分代码静默无数据"。
   */
  technicalBatch: async (codes) => {
    const list = [...new Set([].concat(codes).filter(Boolean).map(String))];
    if (!list.length) return { tables: [], rows: [], fetchedAt: new Date().toISOString(), chunks: 0 };
    const CHUNK = 10;
    const groups = [];
    for (let i = 0; i < list.length; i += CHUNK) groups.push(list.slice(i, i + CHUNK));
    const settled = await Promise.allSettled(groups.map((g) => query(['technical', g.join(',')],
      { ttl: TTL.kline, cacheKey: `tech:${g.join(',')}` })));
    const rows = [];
    const tables = [];
    settled.forEach((r) => {
      if (r.status !== 'fulfilled' || !r.value) return;
      (r.value.tables || []).forEach((t) => { tables.push(t); (t.rows || []).forEach((x) => rows.push(x)); });
    });
    return { tables, rows, chunks: groups.length, fetchedAt: new Date().toISOString() };
  },
  finance: (codes, limit = 8, fields = 'core') =>
    query(['finance', [].concat(codes).join(','), '--limit', String(limit), '--fields', fields],
      { ttl: TTL.finance, cacheKey: `fin:${[].concat(codes).join(',')}:${limit}:${fields}` }),
  disclosure: (code) => query(['disclosure', code], { ttl: TTL.finance, cacheKey: `disc:${code}` }),
  news: (codes, limit = 12) =>
    query(['news', 'list', [].concat(codes).join(','), '--limit', String(limit)], { ttl: TTL.news, cacheKey: `news:${[].concat(codes).join(',')}:${limit}` }),
  newsDetail: (id) =>
    query(['news', 'detail', id], { ttl: TTL.finance, cacheKey: `newsdetail:${id}` }),
  notice: (codes, limit = 12) =>
    query(['notice', 'list', [].concat(codes).join(','), '--limit', String(limit)], { ttl: TTL.news, cacheKey: `notice:${[].concat(codes).join(',')}:${limit}` }),
  report: (codes, limit = 8) =>
    query(['report', 'list', [].concat(codes).join(','), '--limit', String(limit)], { ttl: TTL.news, cacheKey: `report:${[].concat(codes).join(',')}:${limit}` }),
  search: (kw, type = 'stock') =>
    query(['search', kw].concat(type ? ['--type', type] : []), { ttl: TTL.search, cacheKey: `search:${type}:${kw}` }),
  sectorRanking: ({ kind = 'industry', type = 'changePct', order = 'desc' } = {}) =>
    query(['sector', 'ranking', '--kind', kind, '--type', type, '--order', order],
      { ttl: TTL.sector, cacheKey: `secrank:${kind}:${type}:${order}` }),
  sectorConstituent: (code) =>
    query(['sector', 'constituent', code], { ttl: TTL.sector, cacheKey: `secconst:${code}` }),
  sectorInfo: (code) =>
    query(['sector', 'info', code], { ttl: TTL.sector, cacheKey: `secinfo:${code}` }),
  indexConstituent: (code) =>
    query(['index', 'constituent', code], { ttl: TTL.sector, cacheKey: `idxconst:${code}` }),
  indexList: () => query(['index', 'list'], { ttl: TTL.finance, cacheKey: 'idxlist' }),
  /** 沪深港通成份股清单（陆股通标的池）：exchange = sh | sz */
  connect: (exchange = 'sh', limit = 2000, offset = 0) =>
    query(['connect', '--exchange', exchange, '--limit', String(limit), '--offset', String(offset)],
      { ttl: TTL.finance, cacheKey: `connect:${exchange}:${limit}:${offset}`, timeout: 60000 }),
  /** 排行选股：type 见 `westock screen ranking --list` */
  screenRanking: ({ type = 'CompScore', limit = 10, asc = false, extra = [] } = {}) =>
    query(['screen', 'ranking', '--type', type, asc ? '--asc' : '--desc', '--limit', String(limit)].concat(extra),
      { ttl: TTL.sector, cacheKey: `screenrank:${type}:${limit}:${asc}:${extra.join('|')}` }),
  marketOverview: (type = 'profile') =>
    query(['market-overview', '--type', type], { ttl: TTL.sector, cacheKey: `mktov:${type}` }),
  changedist: () => query(['changedist'], { ttl: TTL.quote, cacheKey: 'changedist' }),
  lhb: (type = 'all') => query(['lhb', '--type', type], { ttl: TTL.sector, cacheKey: `lhb:${type}` }),
  sectorValuation: (code) => query(['sector', 'valuation', code], { ttl: TTL.sector, cacheKey: `secval:${code}` }),
  sectorFinance: (code) => query(['sector', 'finance', code], { ttl: TTL.finance, cacheKey: `secfin:${code}` }),
  fundFlow: (codes) => query(['fund', 'flow', [].concat(codes).join(',')], { ttl: TTL.sector, cacheKey: `flow:${[].concat(codes).join(',')}` }),
  hot: (kind = 'stock', limit = 10, { bypass = false } = {}) =>
    query(['hot', kind, '--limit', String(limit)], { ttl: TTL.hot, cacheKey: `hot:${kind}:${limit}`, bypass }),
  /** 市场要闻：热文榜单（自带热度排名），支持 bypass 强制回源以保证时效 */
  hotNews: (limit = 40, { bypass = false } = {}) =>
    query(['hot', 'news', '--limit', String(limit)], { ttl: TTL.hot, cacheKey: `hot:news:${limit}`, bypass }),
  score: (codes) =>
    query(['score', [].concat(codes).join(',')], { ttl: TTL.sector, cacheKey: `score:${[].concat(codes).join(',')}` }),
  calendar: (event = 'all', market = 'hs', limit = 30) =>
    query(['calendar', '--event', event, '--market', market, '--limit', String(limit)], { ttl: TTL.ipo, cacheKey: `cal:${event}:${market}:${limit}` }),
  /** 分时数据（外汇 fx 前缀代码支持；A 股个股亦支持；贵金属 hf_ 前缀实测不支持） */
  minute: (code) => query(['minute', code], { ttl: TTL.quote, cacheKey: `min:${code}` }),
  /** 外汇品种清单（离岸人民币 / 主要货币对 / 美元指数） */
  forexList: () => query(['forex', 'list'], { ttl: TTL.finance, cacheKey: 'forex:list' }),
  /** 股票简况：主营业务描述 / 董事长 / 行业 / 成立与上市日期 / 注册资本 / 地址 / 官网（A股、港股、美股） */
  profile: (codes) =>
    query(['profile', [].concat(codes).join(',')], { ttl: TTL.finance, cacheKey: `profile:${[].concat(codes).join(',')}` }),
};
