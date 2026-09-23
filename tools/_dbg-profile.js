// 最小复现：激进度切换后 seg-item.active 是否跟随
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const EDGE = process.argv[2];
const PORT = Number(process.argv[3] || 9460);
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
  // 不做目录清理（避免触发批量删除安全策略），每次用唯一目录名
  const dir = `C:/Users/huang/.workbuddy/tmp/shots/.dbgprof${PORT}`;
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
  await send('Page.navigate', { url: `${BASE}/#picker/daily` });
  await sleep(16000);

  const snap = () => evalv(`JSON.stringify({
    active: (document.querySelector('#pkProfileSeg .seg-item.active')||{}).dataset ? document.querySelector('#pkProfileSeg .seg-item.active').dataset.profile : null,
    intros: (document.getElementById('pkProfileIntro')||{}).textContent ? document.getElementById('pkProfileIntro').textContent.slice(0,12) : null,
    kpi: (document.querySelector('#pkKpis .kpi .kpi-value')||{}).textContent || null,
  })`);

  console.log('初始:', await snap());
  for (const p of ['conservative', 'aggressive', 'balanced', 'conservative']) {
    await evalv(`(() => { document.querySelector('#pkProfileSeg .seg-item[data-profile="${p}"]').click(); return true; })()`);
    await sleep(3500);
    console.log(`点击 ${p} 后:`, await snap());
  }
  ws.close(); proc.kill();
})();
