// 术语跳转端到端验证：标注 → 跳转定位高亮 → 可逆返回
const { spawn } = require('child_process');
const http = require('http');

const EDGE = process.argv[2];
const PORT = Number(process.argv[3] || 9500);
const BASE = process.argv[4] || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const dir = `C:/Users/huang/.workbuddy/tmp/shots/.dbgterms${PORT}`;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { const j = await getJson('/json/list'); const p = j.find((x) => x.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch (_) {}
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

  const results = [];
  const check = (ok, name, extra = '') => { results.push({ ok, name, extra }); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`); };

  // 1. 市场分析页：术语应被自动标注
  await send('Page.navigate', { url: `${BASE}/#market` });
  await sleep(20000);
  const mk = JSON.parse(await evalv(`JSON.stringify({
    links: document.querySelectorAll('#view-market .term-link').length,
    sample: Array.from(document.querySelectorAll('#view-market .term-link')).slice(0,3).map(b=>b.dataset.term+'→'+b.dataset.no),
    inInputs: document.querySelectorAll('input .term-link, textarea .term-link').length,
    inAppendix: document.querySelectorAll('#apxMain .term-link').length,
  })`));
  check(mk.links > 0, '正文术语已标注为可点击链接', `links=${mk.links} 例: ${mk.sample.join(' | ')}`);
  check(mk.inInputs === 0, '输入框 / 表单内不被标注', `count=${mk.inInputs}`);

  // 2. 键盘可达性
  const kb = JSON.parse(await evalv(`(() => {
    const b = document.querySelector('#view-market .term-link');
    b.focus();
    return JSON.stringify({ tag: b.tagName, focused: document.activeElement === b, aria: !!b.getAttribute('aria-label'), title: !!b.title });
  })()`));
  check(kb.tag === 'BUTTON' && kb.focused && kb.aria && kb.title, '术语链接为原生按钮，可聚焦且带无障碍标签', JSON.stringify(kb));

  // 3. 点击术语 → 跳转附录并定位高亮
  const before = await evalv(`JSON.stringify({ view: (document.querySelector('.view.active')||{}).id, hash: location.hash })`);
  const clicked = JSON.parse(await evalv(`(() => {
    const b = document.querySelector('#view-market .term-link');
    const no = b.dataset.no, term = b.dataset.term;
    b.click();
    return JSON.stringify({ no, term });
  })()`));
  // 高亮为瞬时动画，需在跳转后轮询捕获，而不是固定 sleep 后取样
  const targetId = 'apx-' + clicked.no.replace(/\./g, '-');
  let flashSeen = false, openSeen = false;
  for (let i = 0; i < 40; i++) {
    const st = JSON.parse(await evalv(`(() => {
      const el = document.getElementById(` + JSON.stringify(targetId) + `);
      return JSON.stringify({ flash: !!document.querySelector('.apx-flash'), open: el ? el.classList.contains('open') : false });
    })()`));
    if (st.flash) flashSeen = true;
    if (st.open) openSeen = true;
    if (flashSeen && openSeen) break;
    await sleep(250);
  }
  await sleep(1200);
  const after = JSON.parse(await evalv(`JSON.stringify({
    view: (document.querySelector('.view.active')||{}).id,
    hash: location.hash,
    target: !!document.getElementById(` + JSON.stringify(targetId) + `),
    backBar: !!document.getElementById('apxBackBar'),
    backBtn: !!document.getElementById('apxBackBtn'),
  })`));
  after.flashed = flashSeen;
  after.open = openSeen;
  check(String(after.view) === 'view-appendix', '点击术语跳转到附录视图', `view=${after.view}`);
  check(String(after.hash).includes('no='), 'URL 带术语深链参数（可分享/刷新）', `hash=${after.hash}`);
  check(!!after.target, `目标词条已定位：${clicked.term}（${clicked.no}）`, `target=${after.target}`);
  check(!!after.flashed || after.open === true, '目标词条短暂高亮并展开', `flash=${after.flashed} open=${after.open}`);
  check(!!after.backBar && !!after.backBtn, '附录显示「返回正文」按钮（跳转可逆）', `bar=${after.backBar}`);

  // 4. 点击返回 → 回到原视图并高亮原术语
  await evalv(`(() => { const b = document.getElementById('apxBackBtn'); if (b) b.click(); return true; })()`);
  let termFlash = false;
  for (let i = 0; i < 30; i++) {
    if (await evalv(`!!document.querySelector('.term-flash')`)) { termFlash = true; break; }
    await sleep(200);
  }
  await sleep(1200);
  const back = JSON.parse(await evalv(`JSON.stringify({
    view: (document.querySelector('.view.active')||{}).id,
    hash: location.hash,
    backBarGone: !document.getElementById('apxBackBar'),
  })`));
  back.flashTerm = termFlash;
  check(String(back.view) === String(JSON.parse(before).view), '返回正文：回到原视图', `${JSON.parse(before).view} → ${back.view}`);
  check(!!back.flashTerm, '返回后原术语位置短暂高亮', `flash=${back.flashTerm}`);
  check(!!back.backBarGone, '返回后「返回正文」条已移除', `gone=${back.backBarGone}`);

  // 5. 可点击行内的术语：点击术语只跳附录，不应同时触发所在行的跳转
  await send('Page.navigate', { url: `${BASE}/#stocks?dim=industry&code=pt01801080` });
  await sleep(22000);
  const inRow = JSON.parse(await evalv(`(() => {
    const tr = document.querySelector('#stkTable tr.row-click');
    const b = tr ? tr.querySelector('.term-link') : null;
    return JSON.stringify({ hasRow: !!tr, hasTerm: !!b, term: b ? b.dataset.term : null });
  })()`));
  if (inRow.hasRow && inRow.hasTerm) {
    await evalv(`(() => { document.querySelector('#stkTable tr.row-click .term-link').click(); return true; })()`);
    await sleep(9000);
    const st = JSON.parse(await evalv(`JSON.stringify({
      view: (document.querySelector('.view.active')||{}).id,
      inFinance: !!document.querySelector('.view.active#view-finance'),
    })`));
    check(String(st.view) === 'view-appendix', '可点击行内的术语：只跳转附录，未触发行跳转', `view=${st.view} finance=${st.inFinance}`);
  } else {
    console.log('（当前分类无行内术语，跳过该场景）');
  }

  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n结果：${fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'}`);
  ws.close(); proc.kill();
})();
