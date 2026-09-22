/**
 * qa.js — 基于 CDP 的前端联调脚本（零依赖，Node 22 内置 WebSocket）
 * 用途：遍历四大视图捕获控制台错误，并对通知中心抽屉做交互截图。
 * 用法：node qa.js <edgePath> <debugPort> <baseUrl>
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = process.argv[2];
const PORT = Number(process.argv[3] || 9222);
const BASE = process.argv[4] || 'http://127.0.0.1:8787';
const OUT = process.argv[5] || path.join(__dirname, 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  // 需要连接「页面」目标（type=page）；/json/version 给的是浏览器级目标，不支持 Runtime/Page 域
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* not ready */ }
    await sleep(250);
  }
  throw new Error('无法连接 Chrome DevTools 协议端口（未找到页面目标）');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach((h) => h(msg.params));
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, 60000);
    });
  }
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1600',
    `--user-data-dir=${path.join(OUT, 'cdp-profile')}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const problems = [];
  const logs = [];

  try {
    const wsUrl = await getWsUrl();
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);

    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      logs.push({ type: p.type, text });
      if (p.type === 'error') problems.push(`[console.error] ${text}`);
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常';
      problems.push(`[uncaught] ${msg}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.level === 'error' && !/favicon/i.test(e.text || '')) problems.push(`[log] ${e.text}`);
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    // 记录失败的网络请求
    cdp.on('Network.responseReceived', (p) => {
      const r = p.response || {};
      if (r.status >= 400 && !/favicon/i.test(r.url || '')) problems.push(`[http ${r.status}] ${r.url}`);
    });

    const views = [
      { hash: '#overview', name: 'overview', wait: 9000, shot: true },
      { hash: '#ipo', name: 'ipo', wait: 7000, shot: true },
      { hash: '#ipo/hk', name: 'ipo-hk', wait: 6000, shot: false },
      { hash: '#iponews', name: 'iponews', wait: 14000, shot: true },
      { hash: '#iponews?market=hk', name: 'iponews-hk', wait: 12000, shot: false },
      { hash: '#stocks', name: 'stocks', wait: 14000, shot: true },
      { hash: '#stocks?dim=industry&code=pt01801080', name: 'stocks-industry', wait: 16000, shot: false },
      { hash: '#stocks?dim=concept', name: 'stocks-concept', wait: 13000, shot: false },
      { hash: '#stocks?dim=industry2', name: 'stocks-industry2', wait: 12000, shot: false },
      { hash: '#stocks?dim=connect', name: 'stocks-connect', wait: 20000, shot: false },
      { hash: '#stocks?dim=watch', name: 'stocks-watch', wait: 14000, shot: false },
      { hash: '#stocks?dim=hk&code=hsi', name: 'stocks-hk', wait: 12000, shot: true },
      { hash: '#appendix?no=C.2.1', name: 'appendix-guide', wait: 9000, shot: false },
      { hash: '#recommend', name: 'recommend', wait: 16000, shot: true },
      { hash: '#recommend?board=value', name: 'recommend-value', wait: 16000, shot: false },
      { hash: '#picker', name: 'picker-daily', wait: 18000, shot: true },
      { hash: '#picker/holdings', name: 'picker-holdings', wait: 20000, shot: true },
      { hash: '#gmarkets', name: 'gmarkets-metals', wait: 14000, shot: true },
      { hash: '#gmarkets/forex', name: 'gmarkets-forex', wait: 16000, shot: true },
      { hash: '#worlddesk', name: 'worlddesk', wait: 25000, shot: true },
      { hash: '#picker/manage', name: 'picker-manage', wait: 18000, shot: true },
      { hash: '#appendix', name: 'appendix', wait: 8000, shot: true },
      { hash: '#appendix?no=A.3.5', name: 'appendix-deeplink', wait: 9000, shot: false },
      { hash: '#finance/single', name: 'finance-single', wait: 9000, shot: true },
      { hash: '#finance/single?code=sz000858', name: 'finance-by-code', wait: 12000, shot: false },
      { hash: '#finance/compare', name: 'finance-compare', wait: 12000, shot: true },
      { hash: '#finance/calendar', name: 'finance-calendar', wait: 7000, shot: true },
      { hash: '#market', name: 'market', wait: 14000, shot: true },
      { hash: '#market/report', name: 'market-report', wait: 14000, shot: false },
    ];

    for (const v of views) {
      const before = problems.length;
      await cdp.send('Page.navigate', { url: `${BASE}/${v.hash}` });
      await sleep(v.wait);
      if (v.shot) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(OUT, `qa-${v.name}.png`), Buffer.from(shot.data, 'base64'));
      }
      const added = problems.length - before;
      console.log(`${added === 0 ? '✓' : '✗'} ${v.name}${added ? `  (${added} 个问题)` : ''}`);
    }

    // 交互：打开通知中心抽屉
    await cdp.send('Page.navigate', { url: `${BASE}/#overview` });
    await sleep(8000);
    await cdp.send('Runtime.evaluate', { expression: 'window.Notify && Notify.open()' });
    await sleep(2500);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, 'qa-drawer.png'), Buffer.from(shot.data, 'base64'));

    // 交互：切换到订阅管理页签
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('.dtab[data-filter="subs"]').click()`,
    });
    await sleep(1500);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, 'qa-drawer-subs.png'), Buffer.from(shot.data, 'base64'));

    // 交互：财报「多期趋势」页签
    await cdp.send('Runtime.evaluate', { expression: 'window.Notify && Notify.close()' });
    await sleep(600);
    await cdp.send('Page.navigate', { url: `${BASE}/#finance/single` });
    await sleep(11000);
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('.tab[data-tab="trend"]').click()`,
    });
    await sleep(3000);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, 'qa-fin-trend.png'), Buffer.from(shot.data, 'base64'));

    // 交互：资产负债表页签
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('.tab[data-tab="balance"]').click()`,
    });
    await sleep(1500);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, 'qa-fin-balance.png'), Buffer.from(shot.data, 'base64'));

    // 交互：切换到「多期趋势」页签并截图
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('.tab[data-tab="trend"]').click()`,
    });
    await sleep(2500);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, 'qa-fin-trend2.png'), Buffer.from(shot.data, 'base64'));

    // ---- 路由回归：反复切换子模式后，UI 必须与 URL 一致 ----
    console.log('\n=== 路由回归检查 ===');
    const seq = [
      ['#finance/calendar', 'calendar'],
      ['#finance/single', 'single'],
      ['#finance/compare', 'compare'],
      ['#finance/calendar', 'calendar'],
      ['#finance/single', 'single'],
      ['#ipo/hk', null],
      ['#ipo', null],
      ['#iponews', null],
      ['#stocks', null],
      ['#recommend', null],
      ['#appendix', null],
      ['#market', null],
      ['#overview', null],
      ['#finance/compare', 'compare'],
    ];

    // 新模块的激活态断言
    const EXTRA_ASSERT = {
      '#iponews': { sel: '.nav-item.active', attr: 'view', expect: 'iponews', label: '新股资讯激活' },
      '#stocks': { sel: '.nav-item.active', attr: 'view', expect: 'stocks', label: '股票列表激活' },
      '#recommend': { sel: '.nav-item.active', attr: 'view', expect: 'recommend', label: '推荐榜单激活' },
      '#picker': { sel: '.nav-item.active', attr: 'view', expect: 'picker', label: 'AI 选股激活' },
      '#appendix': { sel: '.nav-item.active', attr: 'view', expect: 'appendix', label: '附录激活' },
    };

    for (const [hash, expectMode] of seq) {
      await cdp.send('Page.navigate', { url: `${BASE}/${hash}` });
      await sleep(hash.includes('compare') || hash.includes('market') || hash.includes('stocks') || hash.includes('recommend') || hash.includes('appendix') ? 12000 : 5000);
      const r = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          hash: location.hash,
          activeMode: (document.querySelector('#finModeSeg .seg-item.active')||{}).dataset
            ? document.querySelector('#finModeSeg .seg-item.active').dataset.mode : null,
          activeMarket: (document.querySelector('#ipoMarketSeg .seg-item.active')||{}).dataset
            ? document.querySelector('#ipoMarketSeg .seg-item.active').dataset.market : null,
          activeView: (document.querySelector('.nav-item.active')||{}).dataset
            ? document.querySelector('.nav-item.active').dataset.view : null,
          finSingleHidden: document.getElementById('finSingle').hidden,
          finCompareHidden: document.getElementById('finCompare').hidden,
          finCalendarHidden: document.getElementById('finCalendar').hidden,
          visibleView: (document.querySelector('.view.active')||{}).id || null,
        })`,
        returnByValue: true,
      });
      const st = JSON.parse(r.result.value);
      let ok = true, why = [];
      if (st.hash !== hash) { ok = false; why.push(`hash=${st.hash}`); }
      if (expectMode && st.activeMode !== expectMode) { ok = false; why.push(`mode=${st.activeMode} 期望 ${expectMode}`); }
      if (expectMode === 'single' && st.finSingleHidden) { ok = false; why.push('单公司面板被隐藏'); }
      if (expectMode === 'compare' && st.finCompareHidden) { ok = false; why.push('对比面板被隐藏'); }
      if (expectMode === 'calendar' && st.finCalendarHidden) { ok = false; why.push('日历面板被隐藏'); }
      const ex = EXTRA_ASSERT[hash];
      if (ex) {
        if (st.activeView !== ex.expect) { ok = false; why.push(`${ex.label}: view=${st.activeView}`); }
        if (st.visibleView !== `view-${ex.expect}`) { ok = false; why.push(`可见视图=${st.visibleView}`); }
      }
      console.log(`${ok ? '✓' : '✗'} ${hash}${ok ? '' : '  → ' + why.join('; ')}`);
      if (!ok) problems.push(`[路由] ${hash}: ${why.join('; ')}`);
    }

    console.log('\n=== 控制台/网络问题汇总 ===');
    if (!problems.length) console.log('无错误');
    else [...new Set(problems)].forEach((p) => console.log(' - ' + p));

    console.log('\n=== console 输出样本 ===');
    logs.slice(0, 20).forEach((l) => console.log(` [${l.type}] ${String(l.text).slice(0, 160)}`));

    ws.close();
  } catch (e) {
    console.error('QA 执行失败:', e.message);
  } finally {
    try { proc.kill(); } catch (_) { /* ignore */ }
    await sleep(800);
    process.exit(0);
  }
})();
