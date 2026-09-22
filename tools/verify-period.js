/**
 * verify-period.js — 「财报整理 · 报告期切换」回归测试
 * 覆盖 核心指标 / 利润表 / 资产负债表 / 现金流量表 四个页签，
 * 每轮随机点选一个报告期药丸，断言：激活态变化 + 表头/表体/页脚内容确实随所选报告期刷新。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const EDGE = process.argv[2];
const PORT = Number(process.argv[3] || 9280);
const BASE = process.argv[4] || 'http://127.0.0.1:8787';
const OUT = process.argv[5] || path.join(__dirname, '..', 'data');
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

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  → ' + detail}`);
  if (!ok) failures++;
};

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1700',
    `--user-data-dir=${path.join(OUT, '.verify-profile')}`, 'about:blank'], { stdio: 'ignore' });
  try {
    const ws = new WebSocket(await wsUrl());
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let id = 0; const pending = new Map(); const errs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        errs.push((d.exception && d.exception.description) || d.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errs.push((m.params.args || []).map((x) => x.value || x.description).join(' '));
      }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evalv = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
      return r.result.value;
    };

    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: `${BASE}/#finance/single` });
    await sleep(12000);

    // 状态快照：激活药丸序号 + 激活标签标题 + 表格内容指纹 + 页脚文字
    const snap = `JSON.stringify({
      activeIdx: Array.from(document.querySelectorAll('#finPeriodBar .period-pill')).findIndex(e => e.classList.contains('active')),
      pillCount: document.querySelectorAll('#finPeriodBar .period-pill').length,
      colActiveIdx: Array.from(document.querySelectorAll('#finTabBody thead th')).findIndex(e => e.classList.contains('col-active')) - 1,
      head: Array.from(document.querySelectorAll('#finTabBody thead th')).map(e=>e.textContent).join('|'),
      body: Array.from(document.querySelectorAll('#finTabBody tbody tr')).slice(0,3).map(tr=>tr.textContent.replace(/\\s+/g,'')).join('~'),
      foot: (document.querySelector('#finTabBody p')||{}).textContent ? document.querySelector('#finTabBody p').textContent.replace(/\\s+/g,'').slice(0,60) : null,
      summaryPeriod: (document.querySelector('.ps-head')||{}).textContent ? document.querySelector('.ps-head').textContent.replace(/\\s+/g,'') : null,
    })`;

    console.log('=== 报告期切换回归测试 ===\n');

    // 1) 药丸是否已绑定（核心指标页签，默认）
    const s0 = JSON.parse(await evalv(snap));
    check(s0.pillCount === 12, '核心指标：渲染出 12 个报告期药丸', `实际 ${s0.pillCount}`);
    check(s0.activeIdx === 0, '核心指标：初始选中第 1 期', `activeIdx=${s0.activeIdx}`);

    await evalv(`document.querySelectorAll('#finPeriodBar .period-pill')[2].click(); true`);
    await sleep(900);
    const s1 = JSON.parse(await evalv(snap));
    check(s1.activeIdx === 2, '核心指标：点击第 3 个药丸后激活态切换', `activeIdx=${s1.activeIdx}`);
    check(s1.colActiveIdx === 2, '核心指标：表格高亮列同步到第 3 列', `colActiveIdx=${s1.colActiveIdx}`);
    check(s1.summaryPeriod !== s0.summaryPeriod, '核心指标：期间速览按所选报告期刷新', `${s0.summaryPeriod} → ${s1.summaryPeriod}`);

    // 2) 利润表
    await evalv(`document.querySelector('#finTabs .tab[data-tab="income"]').click(); true`);
    await sleep(1200);
    const i0 = JSON.parse(await evalv(snap));
    check(i0.activeIdx === 2, '利润表：进入时保持已选报告期', `activeIdx=${i0.activeIdx}`);

    await evalv(`document.querySelectorAll('#finPeriodBar .period-pill')[5].click(); true`);
    await sleep(900);
    const i1 = JSON.parse(await evalv(snap));
    check(i1.activeIdx === 5, '利润表：点击第 6 个药丸后激活态切换', `activeIdx=${i1.activeIdx}`);
    check(i1.body !== i0.body, '利润表：表体金额随所选报告期变化', '表体内容未变');
    check(i1.foot !== i0.foot, '利润表：页脚报告期说明同步更新', '页脚未变');

    // 3) 资产负债表
    await evalv(`document.querySelector('#finTabs .tab[data-tab="balance"]').click(); true`);
    await sleep(1000);
    const b0 = JSON.parse(await evalv(snap));
    await evalv(`document.querySelectorAll('#finPeriodBar .period-pill')[8].click(); true`);
    await sleep(900);
    const b1 = JSON.parse(await evalv(snap));
    check(b1.activeIdx === 8, '资产负债表：切换生效', `activeIdx=${b1.activeIdx}`);
    check(b1.body !== b0.body, '资产负债表：表体随报告期变化', '表体内容未变');

    // 4) 现金流量表
    await evalv(`document.querySelector('#finTabs .tab[data-tab="cash"]').click(); true`);
    await sleep(1000);
    const c0 = JSON.parse(await evalv(snap));
    check(c0.activeIdx === 8, '现金流量表：跨页签保持所选报告期', `activeIdx=${c0.activeIdx}`);
    await evalv(`document.querySelectorAll('#finPeriodBar .period-pill')[10].click(); true`);
    await sleep(900);
    const c1 = JSON.parse(await evalv(snap));
    check(c1.activeIdx === 10, '现金流量表：切换生效', `activeIdx=${c1.activeIdx}`);
    check(c1.body !== c0.body, '现金流量表：表体随报告期变化', '表体内容未变');

    // 5) 回到核心指标，确认选择被保持
    await evalv(`document.querySelector('#finTabs .tab[data-tab="core"]').click(); true`);
    await sleep(1000);
    const back = JSON.parse(await evalv(snap));
    check(back.activeIdx === 10, '切回核心指标：所选报告期保持', `activeIdx=${back.activeIdx}`);
    check(back.colActiveIdx === 10, '切回核心指标：高亮列与新选择一致', `colActiveIdx=${back.colActiveIdx}`);

    // 6) 边界：首/末期可切换
    await evalv(`document.querySelectorAll('#finPeriodBar .period-pill')[0].click(); true`);
    await sleep(700);
    const first = JSON.parse(await evalv(snap));
    check(first.activeIdx === 0, '边界：可切回第 1 期', `activeIdx=${first.activeIdx}`);
    await evalv(`document.querySelectorAll('#finPeriodBar .period-pill')[11].click(); true`);
    await sleep(700);
    const last = JSON.parse(await evalv(snap));
    check(last.activeIdx === 11, '边界：可切到最后一期', `activeIdx=${last.activeIdx}`);

    // 7) 换标的应重置为第 1 期
    //   注意：需派发 input 事件触发应用自身的防抖搜索，否则下拉不会刷新
    const swRes = await evalv(`(async () => {
      await new Promise(r => setTimeout(r, 600));
      const inp = document.querySelector('#finSearch');
      inp.value = '五粮液';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 2000));
      const item = document.querySelector('#finSuggest .suggest-item');
      if (!item) return { err: '搜索下拉未出现' };
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await new Promise(r => setTimeout(r, 9000));
      return {
        hero: (document.querySelector('.fin-hero-name') || {}).textContent,
        activeIdx: Array.from(document.querySelectorAll('#finPeriodBar .period-pill')).findIndex(e => e.classList.contains('active')),
        tabs: (document.querySelector('#finTabs .tab.active') || {}).dataset ? document.querySelector('#finTabs .tab.active').dataset.tab : null,
      };
    })()`);
    if (swRes && swRes.err) {
      check(false, '换标的：搜索并选中新标的', swRes.err);
    } else {
      // 名称可能含全角空格（如「五 粮 液」），比较前先去空白
      const heroName = String(swRes.hero || '').replace(/\s+/g, '');
      check(/五粮液/.test(heroName), '换标的：已加载新标的', `hero=${heroName}`);
      check(swRes.activeIdx === 0, '换标的：报告期索引重置为第 1 期', `activeIdx=${swRes.activeIdx}`);
      check(swRes.tabs === 'core', '换标的：页签重置为「核心指标」', `tab=${swRes.tabs}`);
    }

    console.log(`\n=== 控制台错误 ===\n${errs.length ? errs.join('\n') : '无'}`);
    console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`);
    ws.close();
  } catch (e) {
    console.error('回归测试失败:', e.message);
  } finally {
    try { proc.kill(); } catch (_) { /* ignore */ }
    await sleep(600);
    process.exit(failures ? 1 : 0);
  }
})();
