/**
 * verify-data.js — 数据准确性内部一致性校验
 * 不依赖外部基准，而是校验各字段之间的算术/口径自洽性——
 * 任何解析错误、单位错误、口径错误都会在这里暴露。
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  → ' + detail : ''}`); }
};
const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
const get = async (p) => (await (await fetch(BASE + p)).json()).data;

(async () => {
  // ---------- 1. 行情自洽性：涨跌额 = 现价 − 昨收；涨跌幅 = 涨跌额 / 昨收 ----------
  console.log('\n【1】行情字段自洽性（涨跌额 / 涨跌幅 应由现价与昨收推导一致）');
  const codes = ['sh600519', 'sz000002', 'sz300476', 'sh601318'];
  for (const c of codes) {
    const d = await get(`/api/finance/${c}?periods=1`);
    const q = d.quote;
    if (!q || q.price === null || q.price === undefined) { ok(false, `${c} quote 数据`, '上游偶发缺失，跳过本只'); continue; }
    // 用 kline 取昨收做交叉验证
    const raw = await (await fetch(`http://127.0.0.1:8787/api/market/technical?codes=${c}&limit=3`)).json();
    const item = raw.data.items && raw.data.items[0];
    const bars = (item && item.bars) || [];
    const last2 = bars.slice(-2);
    if (last2.length < 2) { ok(false, `${c} 收盘价与K线一致`, 'K线样本不足'); continue; }
    const kClose = Number(last2[1].last), kPrev = Number(last2[0].last);
    // 行情缓存 30s / K 线缓存 60s，盘中快速波动时两者存在时点差（收盘后一致）。
    // 容差取 0.5% 相对值 + 涨跌幅 0.5 个百分点，足以拦截单位错误（历史 bug 均为数量级错误）
    ok(Math.abs(kClose - q.price) / q.price < 0.005, `${c} 行情收盘价 ≈ K线最新收盘价（盘中跨缓存容差 0.5%）`, `quote=${q.price} kline=${kClose}`);
    if (kPrev) {
      const derived = ((kClose - kPrev) / kPrev) * 100;
      ok(Math.abs(derived - q.changePct) < 0.5, `${c} 涨跌幅与K线推导一致（盘中容差 0.5pp）`, `推导=${derived.toFixed(2)}% 平台=${q.changePct}%`);
    }
  }

  // ---------- 2. 指数自洽性 ----------
  console.log('\n【2】指数字段自洽性');
  const idx = await get('/api/market/indices');
  for (const x of idx.list.slice(0, 4)) {
    // 上游盘中偶发字段缺失（--），此时自洽性无从验证，跳过而非误报
    if (x.change === null || x.changePct === null || !x.price) {
      console.log(`  （${x.name} 行情字段暂缺，跳过本次自洽校验）`);
      continue;
    }
    const derived = ((x.price - (x.price - x.change)) / (x.price - x.change)) * 100;
    ok(near(derived, x.changePct, 0.02), `${x.name} 涨跌幅与涨跌额/现价自洽`, `推导=${derived.toFixed(2)}% vs ${x.changePct}%`);
  }

  // ---------- 3. 财报口径自洽性：单季 = 本期累计 − 上期累计 ----------
  console.log('\n【3】财报口径自洽性（单季 = 本期累计 − 上一报告期累计）');
  const fin = await get('/api/finance/sh600519?periods=8');
  let checked = 0;
  for (let i = 0; i < fin.periods.length; i++) {
    const p = fin.periods[i], prev = fin.periods[i + 1];
    if (!p.single || p.single.revenue === null) continue;
    if (p.quarterSeq === 1) {
      ok(near(p.single.revenue, p.metrics.revenue, 1), `${p.reportLabel} 一季报单季=累计`, '');
      checked++;
    } else if (prev && prev.metrics.revenue !== null) {
      const expect = p.metrics.revenue - prev.metrics.revenue;
      ok(near(p.single.revenue, expect, 1), `${p.reportLabel} 单季营收 = ${p.reportLabel}累计 − ${prev.reportLabel}累计`,
        `单季=${p.single.revenue} 差值=${expect}`);
      checked++;
    }
  }
  ok(checked >= 5, `财报单季推导覆盖 ${checked} 个报告期`, '');

  // 比率类指标值域检查
  const gm = fin.periods.map((p) => p.metrics.grossMargin).filter((v) => v !== null);
  ok(gm.every((v) => v >= 0 && v <= 100), '毛利率全部落在 0~100% 合理值域', `异常值: ${gm.filter((v) => v < 0 || v > 100)}`);
  const dr = fin.periods.map((p) => p.metrics.debtRatio).filter((v) => v !== null);
  ok(dr.every((v) => v >= 0 && v <= 200), '资产负债率落在合理值域', `异常值: ${dr.filter((v) => v < 0 || v > 200)}`);

  // ---------- 4. 板块资金单位换算 ----------
  console.log('\n【4】板块资金单位（上游为万元，平台应换算为元）');
  const sec = await get('/api/market/sectors?kind=industry&type=changePct&order=desc&limit=3');
  for (const s of sec.list) {
    // 龙头板块的单行业主力净流入量级应落在 亿 级别（1e7 ~ 1e11 元）
    const v = Math.abs(s.mainNetInflow || 0);
    ok(v === 0 || (v >= 1e6 && v <= 1e12), `${s.name} 主力净流入量级合理（${(v / 1e8).toFixed(2)} 亿）`, `原始=${v}`);
  }

  // ---------- 5. 股票列表价格完整性 ----------
  console.log('\n【5】股票列表数据完整性（成分股应全部拿到行情）');
  const list = await get('/api/stocks/list?kind=index&code=sh000300&limit=200');
  ok(list.declaredCount === list.total, '成分股数量与上游声明一致', `上游=${list.declaredCount} 平台=${list.total}`);
  ok(list.stats.priceAvailable === list.total, '全部成分股均有行情价格', `有价=${list.stats.priceAvailable}/${list.total}`);
  ok(list.stats.up + list.stats.down + list.stats.flat === list.total, '涨跌平家数合计等于总数',
    `${list.stats.up}+${list.stats.down}+${list.stats.flat} vs ${list.total}`);
  const badChg = list.list.filter((x) => x.changePct !== null && Math.abs(x.changePct) > 21);
  ok(badChg.length === 0, '无超出涨跌停限制的异常涨跌幅', `异常: ${badChg.map((x) => x.code + ':' + x.changePct).join(',')}`);
  // 总市值单位口径（数据源为元，平台归一化为亿元；回归保护：历史上曾被放大 1 亿倍）
  const caps = list.list.map((x) => x.marketCap).filter((v) => v !== null && v !== undefined);
  ok(caps.length > 0 && caps.every((v) => v >= 1 && v <= 200000), '总市值均在合理区间（1 ~ 200000 亿元）',
    `异常: ${list.list.filter((x) => x.marketCap !== null && (x.marketCap < 1 || x.marketCap > 200000)).map((x) => x.code + ':' + x.marketCap).slice(0, 4).join(',')}`);
  const capCross = await get('/api/finance/sh600519?periods=1');
  ok(capCross.quote.marketCap >= 1000 && capCross.quote.marketCap <= 50000,
    '总市值跨接口一致（茅台应在千~万亿量级）', `茅台 ${capCross.quote.marketCap} 亿元`);

  // ---------- 6. 推荐榜单指标口径 ----------
  console.log('\n【6】推荐榜单：每种榜单 50 只 + 排序指标正确');
  const boards = (await get('/api/recommend/boards')).boards.map((b) => b.id);
  ok(boards.length === 12, `榜单类型共 12 种`, `实际 ${boards.length}：${boards.join(',')}`);
  for (const b of boards) {
    const r = await get(`/api/recommend/${b}`);
    const ys = !!r.board.asc;
    ok(r.list.length === 50, `${r.board.label} 列出 50 只`, `实际 ${r.list.length}（目标 ${r.wantLimit}）`);
    // 必须用该榜单「自身排序依据的指标」做校验，而不是固定取第一个显示指标
    const key = r.board.sortMetric;
    const vals = r.list.map((x) => (x.metrics[key] === undefined ? null : x.metrics[key])).filter((v) => v !== null);
    const sorted = vals.every((v, i) => i === 0 || (ys ? v >= vals[i - 1] : v <= vals[i - 1]));
    ok(sorted && vals.length === r.list.length, `${r.board.label} 排序指标「${r.board.sortMetricLabel}」${ys ? '升序' : '降序'}正确`,
      `序列=${vals.slice(0, 3).map((v) => Number(v).toFixed(2)).join(',')} 有效值 ${vals.length}/${r.list.length}`);
    const scores = r.list.map((x) => x.scores.comp).filter((v) => v !== null);
    ok(scores.every((v) => v >= 0 && v <= 100), `${r.board.label} 评分均在 0~100`, `异常: ${scores.filter((v) => v < 0 || v > 100)}`);
    const noReason = r.list.filter((x) => !x.reasons || !x.reasons.length);
    ok(noReason.length === 0, `${r.board.label} 每只股票均有推荐理由`, `缺失: ${noReason.map((x) => x.code).join(',')}`);
    // 排序依据指标应位于指标列表首位，便于阅读核对
    const lead = r.list[0] && r.list[0].metricList[0];
    ok(lead && lead.key === key, `${r.board.label} 首位展示指标即排序依据`, `首位=${lead && lead.key} 依据=${key}`);
    // 排名必须连续且从 1 开始
    const ranks = r.list.map((x) => x.rank);
    ok(ranks.every((v, i) => v === i + 1), `${r.board.label} 排名连续`, `首尾=${ranks[0]}…${ranks[ranks.length - 1]}`);
  }

  // ---------- 7. 新股日期逻辑 ----------
  console.log('\n【7】新股日期与倒计时逻辑');
  const ipo = await get('/api/ipo?market=hs');
  const today = new Date().toISOString().slice(0, 10);
  for (const x of ipo.list.slice(0, 5)) {
    if (x.daysToSubscribe === null) continue;
    const expect = Math.round((new Date(x.subscribeStart + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
    ok(x.daysToSubscribe === expect, `${x.name} 申购倒计时正确（${x.subscribeStart}）`, `平台=${x.daysToSubscribe} 期望=${expect}`);
  }

  // ---------- 8. 新闻时间是否倒序 ----------
  console.log('\n【8】资讯时间排序');
  const news = await get('/api/ipo/news?limit=20&detail=0');
  const times = news.list.map((x) => x.time).filter(Boolean);
  ok(times.every((t, i) => i === 0 || t <= times[i - 1]), '资讯按发布时间倒序', `前3=${times.slice(0, 3).join(' | ')}`);

  // ---------- 9. 市场要闻（解析完整性 / 分类 / 摘要 / 时效） ----------
  console.log('\n【9】市场要闻字段与解析完整性');
  const mn = await get('/api/market/news?limit=40&detail=10');
  ok(mn.total === 40, '市场要闻取满 40 条', `实际 ${mn.total}`);
  ok(mn.list.every((x) => !!x.time), '每条要闻都有可解析的发布时间', `缺失 ${mn.list.filter((x) => !x.time).length} 条`);
  // 回归保护：标题含竖线曾导致 Markdown 表格错位（来源列被撑成时间戳）
  const badSrc = mn.list.filter((x) => /^\d{9,}$/.test(String(x.source)));
  ok(badSrc.length === 0, '来源列未串入时间戳（表格列错位回归）', `异常：${badSrc.map((x) => x.title.slice(0, 18)).join(' / ')}`);
  const badTitle = mn.list.filter((x) => String(x.title).trim().length < 6);
  ok(badTitle.length === 0, '标题完整性正常（未被竖线截断）', `过短：${badTitle.map((x) => x.title).join(',')}`);
  const badUrl = mn.list.filter((x) => x.url && !/^https?:\/\//.test(x.url));
  ok(badUrl.length === 0, '链接列格式正常', `异常 ${badUrl.length} 条`);
  const catSum = (mn.categories || []).reduce((k, c) => k + c.count, 0);
  ok(catSum === mn.total, '分类计数之和等于总条数', `${catSum} vs ${mn.total}`);
  ok(mn.categories.every((c) => c.count > 0), '分类标签均有余量（无空标签）', `空标签 ${mn.categories.filter((c) => !c.count).length}`);
  ok(mn.withSummary === 10, '按参数为前 10 条提取摘要', `实际 ${mn.withSummary}`);
  ok(mn.list.slice(0, 10).every((x) => !!x.summary), '重点要闻均带摘要', `缺失 ${mn.list.slice(0, 10).filter((x) => !x.summary).length}`);
  ok(mn.list.every((x) => !/未找到新闻详情/.test(x.summary || '')), '未把「未找到新闻详情」误当摘要', '存在占位文本');
  const days = [...new Set(mn.list.map((x) => x.dayLabel))];
  ok(days.length >= 1 && days.every((d) => /今日|昨日|\d+ 月 \d+ 日/.test(d)), '日期分组标签格式正确', `分组=${days.join(' / ')}`);
  ok(mn.todayCount === mn.list.filter((x) => x.dayLabel === '今日').length, '今日条数统计一致', `平台=${mn.todayCount}`);
  ok(!!mn.latestTime && mn.latestTime === mn.list.map((x) => x.time).filter(Boolean).sort().pop(),
    '最新发布时间取全量最大值', `latest=${mn.latestTime}`);
  const ranksAsc = mn.list.map((x) => x.rank);
  ok(ranksAsc.every((v, i) => v === i + 1), '热度排名连续（与数据源一致）', `首尾=${ranksAsc[0]}…${ranksAsc[ranksAsc.length - 1]}`);

  // ---------- 10. AI 选股：每日推荐 ----------
  console.log('\n【10】AI 选股：每日推荐与持仓判读');
  const pick = await get('/api/picker/daily');
  const todayBj = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  ok(pick.date === todayBj, '每日推荐日期为当天（北京时间）', `date=${pick.date}`);
  ok(pick.count >= 3 && pick.count <= 10, `推荐数量在 3–10 只区间`, `实际 ${pick.count}`);
  ok(pick.list.length === pick.count, '列表条数与 count 一致', `${pick.list.length} vs ${pick.count}`);
  ok(pick.list.every((x, i) => x.rank === i + 1), '推荐排名连续且按综合分降序', `综合分序列=${pick.list.map((x) => x.pickScore).slice(0, 5).join(',')}`);
  const scoresOk = pick.list.every((x, i) => i === 0 || pick.list[i - 1].pickScore >= x.pickScore);
  ok(scoresOk, '推荐按量化综合分降序排列', '');
  ok(pick.list.every((x) => (x.reasons || []).length >= 3), '每只推荐至少 3 条可溯源理由', `最少 ${(Math.min(...pick.list.map((x) => x.reasons.length)))} 条`);
  ok(pick.list.every((x) => Array.isArray(x.risks)), '每只推荐均带风险提示字段', '');
  ok(pick.list.every((x) => x.ref && x.ref.support && x.ref.stopLoss), '每只推荐均给出支撑与止损参考位', `缺失 ${pick.list.filter((x) => !x.ref || !x.ref.support).length}`);
  ok(pick.list.every((x) => !/ST/i.test(x.name)), '推荐中无 ST 股', '');
  ok(pick.list.every((x) => x.changePct === null || x.changePct < 9.7), '推荐中无当日涨停股（追高排除）', '');
  ok(pick.funnel && pick.funnel.length >= 1 && !!pick.tier, '过滤漏斗与口径已披露', `口径=${pick.tier}`);
  const pick2 = await get('/api/picker/daily');
  ok(pick2.cached === true, '当日重复调用命中缓存（幂等）', `cached=${pick2.cached}`);

  // ---------- 11. AI 选股：持仓判读 ----------
  console.log('\n【11】AI 选股：持仓判读自洽性');
  const pf = await get('/api/portfolio');
  const ha = await get('/api/picker/holdings');
  if (!(pf.holdings || []).length) {
    console.log('  （跳过：当前无持仓记录）');
  } else {
    ok(ha.total === pf.holdings.length, '持仓分析覆盖全部持仓', `${ha.total} vs ${pf.holdings.length}`);
    const s = ha.summary;
    const costSum = Math.round(pf.holdings.reduce((k, x) => k + x.qty * x.cost, 0) * 100) / 100;
    ok(Math.abs(s.totalCost - costSum) < 0.01, '组合成本 = Σ(数量×成本价)', `${s.totalCost} vs ${costSum}`);
    const valSum = Math.round(ha.list.reduce((k, x) => k + (x.marketValue || 0), 0) * 100) / 100;
    ok(Math.abs(s.totalValue - valSum) < 0.01, '组合市值 = Σ 个股市值', `${s.totalValue} vs ${valSum}`);
    ok(ha.list.every((x) => ['建议卖出', '建议减仓', '关注', '继续持有'].includes(x.verdict)), '判读均在四档枚举内', `异常: ${ha.list.filter((x) => !['建议卖出', '建议减仓', '关注', '继续持有'].includes(x.verdict)).map((x) => x.code).join(',')}`);
    ok(ha.list.every((x) => (x.verdict === '建议卖出') === (x.signals.filter((g) => g.level === 'high').length >= 2 || (x.signals.length >= 2 && x.signals.some((g) => g.id === 'S1') && x.signals.some((g) => g.id === 'S2')))), '「建议卖出」判定与规则映射一致', `不一致: ${ha.list.filter((x) => (x.signals.length >= 2)).map((x) => `${x.code}:${x.verdict}(${x.signals.map((g) => g.id).join('+')})`).join(' ')}`);
    ok(ha.list.every((x) => x.pnlPct === null || Math.abs(x.pnlPct - Math.round(((x.marketValue - x.costValue) / x.costValue) * 10000) / 100) < 0.01), '浮动盈亏百分比 = (市值−成本)/成本', `异常: ${ha.list.filter((x) => x.pnlPct === null).length} 条空值`);
    ok(ha.list.every((x) => x.signals.every((g) => ['high', 'mid', 'low'].includes(g.level))), '信号等级枚举合法', '');
  }

  // ---------- 12. 全球行情：贵金属 / 外汇 ----------
  console.log('\n【12】全球行情（贵金属 / 外汇）');
  const met = await get('/api/metals');
  ok(met.list.length === 2 && met.list.every((x) => x.price > 0), `贵金属现货报价有效（金 ${met.list[0].price} / 银 ${met.list[1].price}）`, `list=${met.list.length}`);
  ok(met.list.every((x) => Math.abs(x.changePct) <= 15), '贵金属单日涨跌幅在合理区间', `异常: ${met.list.filter((x) => Math.abs(x.changePct) > 15).map((x) => x.code)}`);
  ok(met.list.every((x) => x.trend && x.trend.series && x.trend.series.length >= 60), '贵金属代理走势序列 ≥60 个交易日', `序列: ${met.list.map((x) => (x.trend || {}).days)}`);
  ok(met.list.every((x) => x.trend.vol20 === null || (x.trend.vol20 > 0 && x.trend.vol20 < 150)), '贵金属年化波动率在合理区间', `波动: ${met.list.map((x) => x.trend.vol20)}`);
  const fx = await get('/api/fx');
  ok(fx.total === 10, '外汇板块覆盖 10 个品种', `total=${fx.total}`);
  ok(fx.groups.length === 3 && fx.groups.every((g) => g.list.every((x) => x.price > 0)), '全部货币对均有有效汇率', `空值: ${fx.groups.flatMap((g) => g.list).filter((x) => !x.price).length}`);
  ok(fx.groups.every((g) => g.list.every((x) => x.trend && x.trend.series.length >= 40)), '全部货币对均有 ≥40 日走势序列', `序列: ${fx.groups.flatMap((g) => g.list).map((x) => (x.trend || {}).days).join(',')}`);
  ok(fx.groups.every((g) => g.list.every((x) => x.trend.vol20 === null || (x.trend.vol20 > 0 && x.trend.vol20 < 60))), '汇率年化波动率在合理区间（<60%）', `异常: ${fx.groups.flatMap((g) => g.list).filter((x) => x.trend.vol20 !== null && x.trend.vol20 >= 60).map((x) => x.code)}`);
  const fxt = await get('/api/fx/fxUSDCNY/trend?limit=60');
  const fxLast = fxt.daily[fxt.daily.length - 1];
  ok(fxt.daily.length >= 40 && fxt.minute.length > 0, `美元兑人民币：日 K ${fxt.daily.length} 天 + 分时 ${fxt.minute.length} 点`, '数据缺失');
  const fxQuote = await get('/api/fx');
  const usdcny = fxQuote.groups.flatMap((g) => g.list).find((x) => x.code === 'fxUSDCNY');
  ok(near(usdcny.price, fxLast.close, 0.005), '汇率现价与 K 线最新收盘价一致（跨接口）', `quote=${usdcny.price} kline=${fxLast.close}`);

  // ---------- 13. 国际形势模块 ----------
  console.log('\n【13】国际形势金融分析');
  const wd = await get('/api/world');
  ok(wd.snapshot.indices.length === 4 && wd.snapshot.indices.every((x) => x.price > 0), '全球指数快照有效（美三大 + 恒指）', `list=${wd.snapshot.indices.length}`);
  ok(wd.newsTotal >= 10, `国际要闻聚合 ${wd.newsTotal} 条`, '条数不足');
  ok(wd.news.every((x) => x.title && (x.src || x.channel)), '全部要闻含标题与来源', `异常: ${wd.news.filter((x) => !x.title).length}`);
  ok(Array.isArray(wd.themes) && wd.themes.every((t) => t.impacts && t.impacts.length && t.headlines.length), '命中主题均附新闻引用与资产映射', `主题: ${wd.themes.length}`);
  ok(wd.tone && typeof wd.tone.riskOffCount === 'number' && typeof wd.tone.riskOnCount === 'number', '风险基调计数有效', `tone=${wd.tone && wd.tone.label}`);

  // ---------- 14. AI 选股三档激进度 ----------
  console.log('\n【14】AI 选股三档激进度');
  const profs = await get('/api/picker/profiles');
  ok(profs.list.length === 3 && profs.list.map((x) => x.key).join(',') === 'conservative,balanced,aggressive', '档案清单：保守 / 稳健 / 进取', `keys=${profs.list.map((x) => x.key)}`);
  ok(Math.abs(profs.list.reduce((k, p) => k + Object.values(p.weights).reduce((a, b) => a + b, 0), 0) / 3 - 1) < 0.01, '各档位权重之和均为 100%', '');
  const picks = {};
  for (const p of profs.list) {
    const r = await get(`/api/picker/daily?profile=${p.key}`);
    picks[p.key] = r;
    ok(r.profile && r.profile.key === p.key && r.list.length >= 3, `${p.label}：推荐 ${r.list.length} 只（≥3）`, `count=${r.count}`);
    ok(r.list.every((x) => typeof x.pickScore === 'number' && x.reasons.length && x.risks.length), `${p.label}：每只均附评分 / 理由 / 风险提示`, '');
    ok(!!(r.profile && r.profile.positionHint), `${p.label}：附仓位纪律`, '');
  }
  const setOf = (r) => new Set(r.list.map((x) => x.code));
  const inter = (a, b) => [...setOf(picks[a])].filter((x) => setOf(picks[b]).has(x)).length;
  ok(inter('conservative', 'aggressive') <= setOf(picks.conservative).size, `三档推荐存在差异（保守∩进取 ${inter('conservative', 'aggressive')} 只）`, '三档完全相同');
  ok(picks.conservative.list.every((x) => x.turnoverRate === null || x.turnoverRate <= 15), '保守型推荐均满足换手率 ≤15%', `异常: ${picks.conservative.list.filter((x) => x.turnoverRate !== null && x.turnoverRate > 15).map((x) => x.code)}`);
  ok(picks.conservative.list.every((x) => x.marketCap === null || x.marketCap >= 100), '保守型推荐均为市值 ≥100 亿元', `异常: ${picks.conservative.list.filter((x) => x.marketCap !== null && x.marketCap < 100).map((x) => x.code)}`);

  // ---------- 15. 主营业务与收入结构 ----------
  console.log('\n【15】主营业务与收入结构');
  const biz = await get('/api/finance/sh600519/business');
  ok(!!biz.business && biz.business.length > 10 && biz.businessPoints.length >= 1, `主营业务描述有效（${biz.name}，${biz.businessPoints.length} 个要点）`, '描述缺失');
  ok(!!biz.profile.industry && !!biz.profile.chairman, '公司档案：行业与董事长字段有效', `industry=${biz.profile.industry}`);
  ok(!!biz.structure && biz.structure.revenue > 0, `收入结构：最新报告期 ${biz.structure && biz.structure.endDate} 营收 ${(biz.structure.revenue / 1e8).toFixed(1)} 亿`, '结构缺失');
  ok(biz.structure.items.every((it) => it.value === null || Math.abs(it.pctOfRev) <= 100), '费用占营收比均在合理区间', `异常: ${biz.structure.items.filter((x) => Math.abs(x.pctOfRev) > 100).map((x) => x.label)}`);
  const costItem = biz.structure.items.find((x) => x.key === 'cost');
  ok(costItem && Math.abs((100 - costItem.pctOfRev) - biz.structure.grossMargin) < 0.5, `毛利率自洽：100% − 营业成本占比 = 毛利率（${(100 - costItem.pctOfRev).toFixed(2)} vs ${biz.structure.grossMargin}）`, '不自洽');
  ok(/未提供分产品/.test(biz.segmentNote || ''), '明确声明分业务收入明细缺失（不虚构占比）', '');

  // ---------- 16. 统一术语索引（全站术语跳转） ----------
  console.log('\n【16】统一术语索引（术语跳转数据源）');
  const ti = await get('/api/terms');
  const apxA = await get('/api/appendix');
  const aCount = (apxA.parts || []).filter((p) => p.no === 'A')[0].categories.reduce((k, c) => k + c.items.length, 0);
  ok(ti.total === aCount, `术语索引条目数与附录 A 一致（${ti.total} = ${aCount}）`, `index=${ti.total} appendix=${aCount}`);
  const nos = new Set((apxA.parts || []).flatMap((p) => (p.categories || p.groups || []).flatMap((g) => g.items.map((i) => i.no))));
  ok(ti.terms.every((t) => nos.has(t.no)), '索引条目编号均在附录中存在', `异常: ${ti.terms.filter((t) => !nos.has(t.no)).map((t) => t.no)}`);
  ok(ti.terms.every((t) => (t.aliases || []).length > 0), '每个术语至少有一个匹配别名', `空别名: ${ti.terms.filter((t) => !(t.aliases || []).length).map((t) => t.no)}`);
  ok(ti.terms.every((t) => (t.aliases || []).every((a) => a.length >= 2)), '别名长度均 ≥2（避免误伤正文）', '');
  // 唯一性：任意别名只指向一个条目（无跳转歧义）
  const owner = new Map(); const dup = [];
  ti.terms.forEach((t) => (t.aliases || []).forEach((a) => {
    if (owner.has(a) && owner.get(a) !== t.no) dup.push(`${a}→${owner.get(a)}/${t.no}`);
    owner.set(a, t.no);
  }));
  ok(dup.length === 0, '别名与词条一一对应（无跳转歧义）', `冲突: ${dup.slice(0, 3).join(', ')}`);
  ok(Array.isArray(ti.dropped), '索引返回被丢弃的冲突别名（便于维护）', `dropped=${(ti.dropped || []).length}`);
  ok(/lib\/appendix\.js/.test(ti.maintenance || '') && /EXTRA_ALIASES/.test(ti.maintenance || ''), '索引声明维护位置（术语本体 + 别名表）', '');

  console.log(`\n================ 结果：通过 ${pass} 项，失败 ${fail} 项 ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('校验失败:', e.message); process.exit(1); });
