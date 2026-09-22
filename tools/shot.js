/**
 * shot.js — 通用页面截图工具（可指定 hash、可选点击元素）
 * 用法：node shot.js <edgePath> <port> <baseUrl> <outDir> <hash> [clickSelector] [beyond|viewport] [waitMs]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const [EDGE, PORT_ARG, BASE, OUT, HASH, CLICK, MODE, WAIT, SCROLL] = process.argv.slice(2);
const PORT = Number(PORT_ARG || 9260);
const beyond = (MODE || 'beyond') === 'beyond';
const wait = Number(WAIT || 12000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (_) { /* wait */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1700',
    `--user-data-dir=${path.join(OUT, '.shot-profile-' + PORT)}`, 'about:blank'], { stdio: 'ignore' });
  try {
    const ws = new WebSocket(await wsUrl());
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });

    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: `${BASE}/${HASH}` });
    await sleep(wait);
    if (CLICK) {
      await send('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector(${JSON.stringify(CLICK)}); if(e) e.click(); return !!e;})()` });
      await sleep(3000);
    }
    if (SCROLL && SCROLL !== '-') {
      await send('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector(${JSON.stringify(SCROLL)}); if(e){e.scrollIntoView({block:'center'});} return !!e;})()` });
      await sleep(2000);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: beyond });
    const name = HASH.replace(/[^a-z0-9]+/gi, '_') + (CLICK ? '_' + CLICK.replace(/[^a-z0-9]/gi, '') : '') + (SCROLL && SCROLL !== '-' ? '_scrolled' : '');
    const file = path.join(OUT, `shot${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('saved', file);
    ws.close();
  } catch (e) {
    console.error('截图失败:', e.message);
  } finally {
    try { proc.kill(); } catch (_) { /* ignore */ }
    await sleep(600);
    process.exit(0);
  }
})();
