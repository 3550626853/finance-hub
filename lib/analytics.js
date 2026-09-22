'use strict';
/**
 * analytics.js — 多维度统计与趋势分析计算内核
 * 纯函数实现，无外部依赖：均线体系、动量指标、波动率、趋势强度、形态统计。
 */

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : +v.toFixed(d));

// ---------- 基础统计 ----------

function mean(arr) {
  const a = arr.filter((x) => x !== null && Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function stddev(arr) {
  const a = arr.filter((x) => x !== null && Number.isFinite(x));
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function percentile(arr, p) {
  const a = arr.filter((x) => x !== null && Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
function median(arr) { return percentile(arr, 0.5); }

function maxDrawdown(closes) {
  let peak = -Infinity, mdd = 0, peakIdx = 0, troughIdx = 0, curPeakIdx = 0;
  closes.forEach((c, i) => {
    if (c === null) return;
    if (c > peak) { peak = c; curPeakIdx = i; }
    const dd = peak > 0 ? (c - peak) / peak : 0;
    if (dd < mdd) { mdd = dd; peakIdx = curPeakIdx; troughIdx = i; }
  });
  return { mdd: round(mdd * 100, 2), peakIdx, troughIdx };
}

// ---------- 均线体系 ----------

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null) { sum += v; cnt++; }
    if (i >= period) {
      const old = values[i - period];
      if (old !== null) { sum -= old; cnt--; }
    }
    if (i >= period - 1 && cnt === period) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) { out[i] = prev; continue; }
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// ---------- 动量指标 ----------

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) {
        gain /= period; loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const dif = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null));
  const dea = ema(dif.map((d) => (d === null ? 0 : d)), signal);
  const hist = dif.map((d, i) => (d !== null && dea[i] !== null ? (d - dea[i]) * 2 : null));
  return { dif, dea, hist };
}

function kdj(highs, lows, closes, n = 9, m1 = 3, m2 = 3) {
  const rsv = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) continue;
    const hh = Math.max(...highs.slice(i - n + 1, i + 1));
    const ll = Math.min(...lows.slice(i - n + 1, i + 1));
    rsv[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const K = new Array(closes.length).fill(null);
  const D = new Array(closes.length).fill(null);
  const J = new Array(closes.length).fill(null);
  let k = 50, d = 50;
  for (let i = 0; i < closes.length; i++) {
    if (rsv[i] === null) { K[i] = k; D[i] = d; J[i] = 3 * k - 2 * d; continue; }
    k = (2 / 3) * k + (1 / 3) * rsv[i];
    d = (2 / 3) * d + (1 / 3) * k;
    K[i] = k; D[i] = d; J[i] = 3 * k - 2 * d;
  }
  return { K, D, J };
}

function boll(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const up = new Array(closes.length).fill(null);
  const low = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const sd = stddev(win);
    if (mid[i] !== null && sd !== null) { up[i] = mid[i] + mult * sd; low[i] = mid[i] - mult * sd; }
  }
  return { mid, up, low };
}

// ---------- 趋势与形态 ----------

/** 最小二乘斜率，归一化为「每日百分比变化」 */
function trendSlope(values) {
  const pts = [];
  values.forEach((v, i) => { if (v !== null && Number.isFinite(v)) pts.push([i, v]); });
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0;
  pts.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; });
  if (sxx === 0 || !my) return null;
  const slope = sxy / sxx;
  return { slope, pctPerDay: round((slope / my) * 100, 3), r2: round((sxy ** 2) / (sxx * pts.reduce((s, p) => s + (p[1] - my) ** 2, 0) || 1), 3) };
}

/** 年化波动率（%） */
function annualizedVol(closes, window = 20) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] && closes[i - 1]) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const w = rets.slice(-window);
  const sd = stddev(w);
  return sd === null ? null : round(sd * Math.sqrt(252) * 100, 2);
}

/** 支撑 / 阻力（近 N 日分位） */
function supportResistance(highs, lows, closes, window = 60) {
  const h = highs.slice(-window), l = lows.slice(-window), c = closes.slice(-window);
  return {
    support: round(Math.min(...l.filter((x) => x !== null)), 2),
    resistance: round(Math.max(...h.filter((x) => x !== null)), 2),
    p20: round(percentile(c, 0.2), 2),
    p80: round(percentile(c, 0.8), 2),
  };
}

/** 量价关系：近 5 日均量 / 近 20 日均量 */
function volumeRatio(volumes, short = 5, long = 20) {
  const s = mean(volumes.slice(-short));
  const l = mean(volumes.slice(-long));
  return (s && l) ? round(s / l, 2) : null;
}

// ---------- 综合判读 ----------

/**
 * 对一段日线序列做完整技术画像
 * @param {Array<{date,open,last,high,low,volume,amount,change_pct}>} bars
 */
function analyzeSeries(bars) {
  const clean = (bars || [])
    .filter((b) => b && num(b.last) !== null && b.date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date))); // 防呆：确保时间正序
  if (clean.length < 20) {
    return { ok: false, reason: '样本不足（需至少 20 个交易日）', bars: clean.length };
  }
  const dates = clean.map((b) => String(b.date));
  const closes = clean.map((b) => num(b.last));
  const highs = clean.map((b) => num(b.high)).map((v, i) => (v === null ? closes[i] : v));
  const lows = clean.map((b) => num(b.low)).map((v, i) => (v === null ? closes[i] : v));
  const opens = clean.map((b) => num(b.open)).map((v, i) => (v === null ? closes[i] : v));
  const volumes = clean.map((b) => num(b.volume)).map((v) => (v === null ? 0 : v));

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const sma5 = sma(closes, 5), sma10 = sma(closes, 10), sma20 = sma(closes, 20), sma60 = sma(closes, 60);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const m = macd(closes);
  const r = rsi(closes, 14);
  const k = kdj(highs, lows, closes);
  const b = boll(closes, 20, 2);

  const i = closes.length - 1;
  const maArr = [sma5[i], sma10[i], sma20[i], sma60[i]].filter((x) => x !== null);
  const bullStack = sma5[i] !== null && sma10[i] !== null && sma20[i] !== null &&
    sma5[i] > sma10[i] && sma10[i] > sma20[i];
  const bearStack = sma5[i] !== null && sma10[i] !== null && sma20[i] !== null &&
    sma5[i] < sma10[i] && sma10[i] < sma20[i];
  const aboveMA = maArr.length ? maArr.filter((x) => last > x).length / maArr.length : null;

  const win = (n) => {
    const idx = Math.max(0, closes.length - 1 - n);
    const base = closes[idx];
    return base ? round(((last - base) / base) * 100, 2) : null;
  };

  const rets = [];
  for (let x = 1; x < closes.length; x++) if (closes[x] && closes[x - 1]) rets.push((closes[x] - closes[x - 1]) / closes[x - 1] * 100);
  const upDays = rets.filter((x) => x > 0).length;
  const downDays = rets.filter((x) => x < 0).length;

  const slope20 = trendSlope(sma20.slice(-20));
  const slope60 = trendSlope(closes.slice(-60));

  const bollPos = (b.up[i] !== null && b.low[i] !== null && b.up[i] !== b.low[i])
    ? round(((last - b.low[i]) / (b.up[i] - b.low[i])) * 100, 1) : null;

  const mdd = maxDrawdown(closes);

  // 打分 0-10
  let score = 5;
  const notes = [];
  if (bullStack) { score += 1.2; notes.push('均线多头排列（MA5>MA10>MA20），中短期趋势向上'); }
  else if (bearStack) { score -= 1.2; notes.push('均线空头排列（MA5<MA10<MA20），中短期趋势向下'); }
  if (aboveMA !== null) {
    if (aboveMA === 1) { score += 0.8; notes.push('价格站上全部主要均线，多方占优'); }
    else if (aboveMA === 0) { score -= 0.8; notes.push('价格跌破全部主要均线，空方占优'); }
  }
  if (m.hist[i] !== null && m.hist[i - 1] !== null) {
    if (m.hist[i] > 0 && m.hist[i] > m.hist[i - 1]) { score += 0.8; notes.push('MACD 柱状线为正且走强，动能增强'); }
    else if (m.hist[i] < 0 && m.hist[i] < m.hist[i - 1]) { score -= 0.8; notes.push('MACD 柱状线为负且走弱，动能衰减'); }
    if (m.dif[i] !== null && m.dea[i] !== null && m.dif[i] > m.dea[i] && m.dif[i - 1] <= m.dea[i - 1]) { score += 0.6; notes.push('MACD 金叉，短期转强信号'); }
    if (m.dif[i] !== null && m.dea[i] !== null && m.dif[i] < m.dea[i] && m.dif[i - 1] >= m.dea[i - 1]) { score -= 0.6; notes.push('MACD 死叉，短期转弱信号'); }
  }
  if (r[i] !== null) {
    if (r[i] > 75) { score -= 0.6; notes.push(`RSI=${round(r[i], 1)}，进入超买区，短线回调压力`); }
    else if (r[i] < 30) { score += 0.6; notes.push(`RSI=${round(r[i], 1)}，进入超卖区，存在反弹动能`); }
    else notes.push(`RSI=${round(r[i], 1)}，处于中性区间`);
  }
  if (slope60 && slope60.pctPerDay !== null) {
    if (slope60.pctPerDay > 0.15) { score += 0.7; notes.push(`60 日趋势斜率 +${slope60.pctPerDay}%/日，中期上行通道`); }
    else if (slope60.pctPerDay < -0.15) { score -= 0.7; notes.push(`60 日趋势斜率 ${slope60.pctPerDay}%/日，中期下行通道`); }
  }
  const vr = volumeRatio(volumes);
  if (vr !== null) {
    if (vr > 1.4 && last >= prev) { score += 0.5; notes.push(`近 5 日量能放大至 20 日均量的 ${vr} 倍且价涨，量价配合`); }
    else if (vr > 1.4 && last < prev) { score -= 0.5; notes.push(`近 5 日放量下跌（量比 ${vr}），抛压较重`); }
    else if (vr < 0.7) notes.push(`量能萎缩至 20 日均量 ${vr} 倍，观望情绪浓`);
  }
  score = Math.max(0, Math.min(10, score));

  const verdict = score >= 7 ? '偏多' : score >= 5.6 ? '中性偏多' : score >= 4.4 ? '中性' : score >= 3 ? '中性偏空' : '偏空';

  return {
    ok: true,
    bars: clean.length,
    range: { start: dates[0], end: dates[dates.length - 1] },
    price: {
      last: round(last, 2), changePct: prev ? round(((last - prev) / prev) * 100, 2) : null,
      high: round(Math.max(...highs), 2), low: round(Math.min(...lows), 2),
    },
    returns: { d1: win(1), d5: win(5), d20: win(20), d60: win(60), d120: win(120), ytdBase: dates[0] },
    ma: {
      sma5: round(sma5[i], 2), sma10: round(sma10[i], 2), sma20: round(sma20[i], 2), sma60: round(sma60[i], 2),
      ema12: round(e12[i], 2), ema26: round(e26[i], 2),
      bullStack, bearStack, aboveMAratio: aboveMA === null ? null : round(aboveMA * 100, 0),
    },
    macd: { dif: round(m.dif[i], 3), dea: round(m.dea[i], 3), hist: round(m.hist[i], 3) },
    rsi: round(r[i], 1),
    kdj: { k: round(k.K[i], 1), d: round(k.D[i], 1), j: round(k.J[i], 1) },
    boll: { up: round(b.up[i], 2), mid: round(b.mid[i], 2), low: round(b.low[i], 2), position: bollPos },
    sr: supportResistance(highs, lows, closes, Math.min(60, closes.length)),
    stats: {
      volatility: annualizedVol(closes, 20),
      volatility60: annualizedVol(closes, 60),
      upDays, downDays, upRatio: round((upDays / (upDays + downDays || 1)) * 100, 1),
      maxDrawdown: mdd.mdd,
      avgAmp: round(mean(clean.map((x) => Math.abs((num(x.high) - num(x.low)) / (num(x.open) || num(x.last) || 1) * 100))), 2),
      volRatio: vr,
      closeStd: round(stddev(closes.slice(-20)), 2),
    },
    trend: { slope20, slope60 },
    score: round(score, 1),
    verdict,
    notes,
  };
}

/** 多标的横向统计对比 */
function compareSeries(map) {
  return Object.entries(map).map(([code, a]) => ({
    code,
    name: a.name || code,
    price: a.price ? a.price.last : null,
    d1: a.returns ? a.returns.d1 : null,
    d20: a.returns ? a.returns.d20 : null,
    d60: a.returns ? a.returns.d60 : null,
    score: a.score,
    verdict: a.verdict,
    volatility: a.stats ? a.stats.volatility : null,
    maxDrawdown: a.stats ? a.stats.maxDrawdown : null,
    rsi: a.rsi,
    vsMA20: a.ma && a.ma.sma20 ? round(((a.price.last - a.ma.sma20) / a.ma.sma20) * 100, 2) : null,
  })).sort((x, y) => (y.score || 0) - (x.score || 0));
}

/** 数值分布直方图 */
function histogram(values, bins = 10) {
  const a = values.filter((x) => x !== null && Number.isFinite(x));
  if (!a.length) return { labels: [], counts: [] };
  const mn = Math.min(...a), mx = Math.max(...a);
  const w = (mx - mn) / bins || 1;
  const counts = new Array(bins).fill(0);
  a.forEach((v) => { const k = Math.min(bins - 1, Math.floor((v - mn) / w)); counts[k]++; });
  const labels = counts.map((_, k) => `${round(mn + k * w, 1)}~${round(mn + (k + 1) * w, 1)}`);
  return { labels, counts };
}

/** Pearson 相关系数 */
function corr(x, y) {
  const pairs = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) pairs.push([x[i], y[i]]);
  }
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  pairs.forEach(([a, b]) => { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; });
  if (!sxx || !syy) return null;
  return round(sxy / Math.sqrt(sxx * syy), 3);
}

/**
 * 总市值归一化（自适应单位）。
 * 实测：数据源 `quote.total_market_cap` 的单位**跨天漂移**——
 *   2026-09-21 返回「元」（茅台 1,565,815,000,000），
 *   2026-09-22 返回「亿元」（茅台 15,652.9），两者代表同一市值。
 * A 股市值范围：亿元口径 3 ~ 30,000+；元口径 3e8 ~ 3e12+，以 1e6 为界完全分离。
 * 因此按量级自适应：≥1e6 视为「元」（/1e8），否则视为「亿元」直接使用。
 */
function normCap(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n >= 1e6 ? round(n / 1e8, 4) : n;
}

module.exports = {
  num, round, mean, stddev, percentile, median, maxDrawdown,
  sma, ema, rsi, macd, kdj, boll,
  trendSlope, annualizedVol, supportResistance, volumeRatio,
  analyzeSeries, compareSeries, histogram, corr, normCap,
};
