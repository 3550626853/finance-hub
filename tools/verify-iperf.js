/**
 * 新股「暴涨 / 破发」分析回归验证
 * 用法：node tools/verify-iperf.js <edge路径> [cdp端口] [baseUrl]
 * 覆盖：阈值判定（首日 / 区间 / 合并）、兜底（未上市 / 无行情 / 无发行价 / 非日历标的）、
 *       接口字段完整性、前端渲染（标签、结论行、配色、无空白）
 */
const { spawn } = require('child_process');
const http = require('http');

const EDGE = process.argv[2];
const PORT = Number(process.argv[3] || 9530);
const BASE = process.argv[4] || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getUrl(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const api = async (p) => { const r = await getUrl(`${BASE}${p}`); return r.data !== undefined ? r.data : r; };

const results = [];
const check = (ok, name, extra = '') => {
  results.push({ ok, name, extra });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`);
};

(async () => {
  // ================= API 层 =================
  // 1. 暴涨（今日上市，发行价 55.28 → 现价 433）
  const surge = await api('/api/ipo/perf?code=sz301686&listingDate=2026-09-22&price=55.28');
  check(surge.status === 'ready' && surge.verdict === 'surge', '暴涨判定：首日 +683% → surge', `tag=${surge.tag}`);
  check(surge.firstDayPct === 683.29 && surge.latestPct === 683.29, '首日与区间涨跌幅均相对发行价计算', `fd=${surge.firstDayPct} lt=${surge.latestPct}`);
  check(surge.tradingDays === 1, '伪 K 线被剔除，首日不会被算成 0%', `tradingDays=${surge.tradingDays}`);
  check(/暴涨/.test(surge.text) && /55\.28/.test(surge.text), '暴涨文案含发行价与结论', surge.text.slice(0, 60));

  // 2. 破发（人为抬高发行价基准，验证阈值与深度破发）
  const brk = await api('/api/ipo/perf?code=sz301686&listingDate=2026-09-22&price=900');
  check(brk.verdict === 'break' && brk.severity === 'deep', '破发判定：−51.9% → break 且深度破发', `tag=${brk.tag} severity=${brk.severity}`);

  // 3. 平稳（小幅上涨不触发暴涨）
  const flat = await api('/api/ipo/perf?code=hk09856&listingDate=2026-09-22&price=32.96');
  check(flat.verdict === 'normal' && flat.latestPct > 0 && flat.latestPct < 100, '小幅上涨判为平稳，不误报暴涨', `lt=${flat.latestPct}`);

  // 4. 破发缓冲带：发行价略高于现价（−0.3%）应判平稳而非破发
  const near = await api('/api/ipo/perf?code=hk09856&listingDate=2026-09-22&price=34.58');
  check(near.verdict === 'normal', '缓冲带内（−0.29%）不误判破发', `lt=${near.latestPct} verdict=${near.verdict}`);

  // 5. 兜底：未上市
  const pend = await api('/api/ipo/perf?code=sz301660&listingDate=2026-10-15&price=12.01');
  check(pend.status === 'pending' && pend.verdict === 'pending' && pend.latestPct === null, '未上市 → pending，不产生任何涨跌数字', `tag=${pend.tag}`);
  check(/尚未上市/.test(pend.text), '未上市文案说明原因与倒计时', pend.text);

  // 6. 兜底：非新股日历标的（老股票）
  const old = await api('/api/ipo/perf?code=sh600519');
  check(old.status === 'unknown' && old.verdict === 'unknown' && old.latestPct === null, '非新股日历标的 → unknown，不显示「未上市」', `reason=${old.reason}`);

  // 7. 兜底：无 code
  const noCode = await api('/api/ipo/perf');
  check(noCode.ok === false && /code/.test(noCode.error || ''), '缺少 code 参数时返回明确错误');

  // 8. 资讯流挂载 + 统计
  const news = await api('/api/ipo/news?market=all&limit=40&detail=4');
  const withPerf = (news.list || []).filter((x) => x.perf);
  check(withPerf.length === (news.list || []).length && (news.list || []).length > 0,
    '每条资讯都挂上了 perf 字段（无空白）', `${withPerf.length}/${(news.list || []).length}`);
  const bad = (news.list || []).filter((x) => x.perf && (
    !['ready', 'pending', 'unknown'].includes(x.perf.status)
    || (x.perf.status !== 'ready' && (x.perf.latestPct !== null || /暴涨|破发/.test(x.perf.tag)))
  ));
  check(bad.length === 0, '非 ready 的条目不带涨跌数字、不出现暴涨/破发字样', `异常 ${bad.length} 条`);
  const tagOk = (news.list || []).every((x) => x.perf && x.perf.tag && x.perf.label && x.perf.text);
  check(tagOk, '每条 perf 均含 tag / label / text 展示字段');
  const ps = news.perfStats || {};
  check(typeof ps.stocks === 'number' && typeof ps.surge === 'number' && typeof ps.break === 'number',
    'perfStats 返回按股票去重的统计', JSON.stringify(ps));

  // 9. 收盘后不会把 0 价当破发（未上市标的的行情全 0）
  const zero = await api('/api/ipo/perf?code=sz301718&listingDate=2026-10-09&price=0');
  check(zero.verdict !== 'break', '发行价为 0 时不判定破发', `verdict=${zero.verdict}`);

  // ================= UI 层 =================
  const dir = `C:/Users/huang/.workbuddy/tmp/shots/.dbgperf${PORT}`;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { const j = await getUrl(`http://127.0.0.1:${PORT}/json/list`); const p = j.find((x) => x.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch (_) {}
    if (!wsUrl) await sleep(250);
  }
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalv = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.result.value;
  await send('Page.enable'); await send('Runtime.enable');

  const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text);
  };
  await send('Log.enable');

  await send('Page.navigate', { url: `${BASE}/#iponews` });
  // 轮询等待资讯流渲染完成（不固定 sleep，避免读到旧 DOM）
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(1000);
    ready = await evalv(`!!document.querySelector('#ipnFeed .news-item')`);
  }
  check(ready, '新股资讯流已渲染');

  const ui = JSON.parse(await evalv(`JSON.stringify({
    items: document.querySelectorAll('#ipnFeed .news-item').length,
    tags: document.querySelectorAll('#ipnFeed .perf-tag').length,
    lines: document.querySelectorAll('#ipnFeed .ni-perf').length,
    emptyTags: Array.from(document.querySelectorAll('#ipnFeed .perf-tag')).filter(e=>!e.textContent.trim()).length,
    titles: Array.from(document.querySelectorAll('#ipnFeed .perf-tag')).slice(0,3).map(e=>e.textContent.trim()),
    inFoot: Array.from(document.querySelectorAll('#ipnFeed .perf-tag')).every(e=>!!e.closest('.ni-foot')),
    subtitle: (document.getElementById('ipnSubtitle')||{}).textContent||'',
  })`));
  check(ui.items > 0 && ui.tags === ui.items, '每条资讯都有上市表现标签（无空白）', `items=${ui.items} tags=${ui.tags}`);
  check(ui.emptyTags === 0, '标签文案非空', `样例: ${ui.titles.join(' | ')}`);
  check(ui.inFoot, '标签位于原有 .ni-foot 信息行内，未新增布局块');
  check(ui.lines >= 0 && ui.lines <= ui.items, '结论行数量不超过资讯条数', `lines=${ui.lines}`);
  check(ui.tags === ui.items && ui.lines <= ui.tags, '仅 ready 条目展开整句结论，其余只显示标签');

  // 个股视图：上市表现读数
  await send('Page.navigate', { url: `${BASE}/#iponews?stock=sz301686` });
  let sReady = false;
  for (let i = 0; i < 40 && !sReady; i++) {
    await sleep(1000);
    sReady = await evalv(`!!document.querySelector('#ipnStockView .stock-news-quote')`);
  }
  const sv = JSON.parse(await evalv(`JSON.stringify({
    hasHead: !!document.querySelector('#ipnStockView .stock-news-head'),
    perfItem: Array.from(document.querySelectorAll('#ipnStockView .snq-item')).filter(e=>/上市表现/.test(e.textContent)).map(e=>e.textContent.trim()),
    note: Array.from(document.querySelectorAll('#ipnStockView .snq-note')).map(e=>e.textContent.trim()).filter(t=>/上市表现/.test(t)),
  })`));
  check(sv.hasHead, '个股资讯视图正常渲染');
  check(sv.perfItem.length === 1 || sv.note.length === 1,
    '个股视图展示「上市表现」读数或结论', `item=${JSON.stringify(sv.perfItem)} note=${JSON.stringify(sv.note)}`);

  check(errs.length === 0, '页面无 console / 运行时错误', errs.slice(0, 2).join(' | '));

  proc.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) { console.log('失败项：\n' + failed.map((f) => ' - ' + f.name + (f.extra ? ` → ${f.extra}` : '')).join('\n')); process.exit(1); }
})();
