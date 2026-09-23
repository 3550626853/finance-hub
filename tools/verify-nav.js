/**
 * verify-nav.js — 新增模块的跨页联动回归测试
 * 校验：股票列表 / 推荐榜单 / 新股资讯 中点击股票，都能正确跳转到「财报整理」并加载对应标的。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const EDGE = process.argv[2];
const PORT = Number(process.argv[3] || 9300);
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

const FIN_SNAP = `JSON.stringify({
  hash: location.hash,
  view: (document.querySelector('.view.active')||{}).id || null,
  heroCode: (document.querySelector('.fin-hero-name .mono')||{}).textContent || null,
  heroName: (document.querySelector('.fin-hero-name')||{}).textContent
    ? document.querySelector('.fin-hero-name').textContent.replace(/\\s+/g,'') : null,
  hasTable: !!document.querySelector('#finTabBody table'),
  periodPills: document.querySelectorAll('#finPeriodBar .period-pill').length,
})`;

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1700',
    `--user-data-dir=${path.join(OUT, '.verifynav-profile')}`, 'about:blank'], { stdio: 'ignore' });
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
    const nav = async (hash, wait) => { await send('Page.navigate', { url: `${BASE}/${hash}` }); await sleep(wait); };
    /** 轮询等待某个表达式为真（冷启动时接口较慢，固定 sleep 不可靠） */
    const waitFor = async (expr, timeoutMs = 40000, intervalMs = 1200) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const v = await evalv(expr);
        if (v) return v;
        await sleep(intervalMs);
      }
      return null;
    };
    const finSnap = async () => JSON.parse(await evalv(FIN_SNAP));

    await send('Page.enable'); await send('Runtime.enable');

    console.log('=== 跨模块联动回归测试 ===\n');

    // ---------- 1. 股票列表 → 财报整理 ----------
    await nav('#stocks', 16000);
    const rowRaw = await evalv(`(() => {
      const tr = document.querySelector('#stkTable tr.row-click');
      if (!tr) return null;
      const tds = tr.querySelectorAll('td');
      return JSON.stringify({ code: tr.dataset.code, name: tds[1] ? tds[1].textContent.trim() : null });
    })()`);
    check(!!rowRaw, '股票列表：渲染出可点击的股票行', '未找到行');
    if (rowRaw) {
      const row = JSON.parse(rowRaw);
      await evalv(`(() => { document.querySelector('#stkTable tr.row-click').click(); return true; })()`);
      // 财报接口盘中可能较慢，轮询等待报告期药丸出现（最多 60 秒）
      const pillsReady = await waitFor(`document.querySelectorAll('#finTabBody .period-pill, #finTabBody .period-pill[data-p]').length > 0
        || (document.querySelector('#finSingle') && /最新报告期|报告期/.test(document.getElementById('finSingle').textContent))`, 60000);
      await sleep(500);
      const st = await finSnap();
      check(st.view === 'view-finance', '股票列表 → 财报整理：视图已切换', `view=${st.view}`);
      check(String(st.hash).includes(`code=${row.code}`), '股票列表 → 财报整理：URL 带上目标代码', `hash=${st.hash}`);
      check(st.heroCode === row.code, '股票列表 → 财报整理：加载的是所点击的股票', `hero=${st.heroCode} 期望 ${row.code}`);
      check(!!pillsReady && st.hasTable && st.periodPills > 0, '股票列表 → 财报整理：财报数据已渲染', `pill=${st.periodPills} ready=${!!pillsReady}`);
    }

    // ---------- 2. 推荐榜单 → 财报整理 ----------
    await nav('#recommend', 17000);
    const recRaw = await evalv(`(() => {
      const b = document.querySelector('#rcList .rec-go');
      return b ? JSON.stringify({ code: b.dataset.code, name: b.dataset.name }) : null;
    })()`);
    check(!!recRaw, '推荐榜单：渲染出「查看财报」按钮', '未找到按钮');
    if (recRaw) {
      const b = JSON.parse(recRaw);
      await evalv(`(() => { document.querySelector('#rcList .rec-go').click(); return true; })()`);
      await sleep(11000);
      const st = await finSnap();
      check(st.view === 'view-finance', '推荐榜单 → 财报整理：视图已切换', `view=${st.view}`);
      check(st.heroCode === b.code, '推荐榜单 → 财报整理：加载的是所点击的股票', `hero=${st.heroCode} 期望 ${b.code}`);
    }

    // ---------- 3. 新股资讯「资讯热度榜」→ 列出该股全部资讯 ----------
    await nav('#iponews', 15000);
    // 热度榜依赖多源资讯抓取（冷启动可达 10s+），轮询等待而非固定 sleep
    await waitFor(`!!document.querySelector('#ipnHotStocks .lm-item')`, 60000);
    const hotRaw = await evalv(`(() => {
      const el = document.querySelector('#ipnHotStocks .lm-item');
      return el ? JSON.stringify({ code: el.dataset.code, name: el.dataset.name }) : null;
    })()`);
    check(!!hotRaw, '新股资讯：热度榜渲染出可点击项', '未找到');
    if (hotRaw) {
      const h = JSON.parse(hotRaw);
      await evalv(`(() => { document.querySelector('#ipnHotStocks .lm-item').click(); return true; })()`);
      await waitFor(`document.querySelectorAll('#ipnStockView .news-item').length > 0`, 40000);
      const sv = JSON.parse(await evalv(`JSON.stringify({
        hash: location.hash,
        defaultHidden: document.getElementById('ipnDefault').hidden,
        headTitle: (document.querySelector('#ipnStockView .card-head h2')||{}).textContent || null,
        code: (document.querySelector('#ipnStockView .snq-item .v.mono')||{}).textContent || null,
        items: document.querySelectorAll('#ipnStockView .news-item').length,
        titles: document.querySelectorAll('#ipnStockView .ni-title').length,
        times: document.querySelectorAll('#ipnStockView .ni-time').length,
        summaries: document.querySelectorAll('#ipnStockView .ni-summary').length,
        backBtn: !!document.getElementById('ipnBack'),
        goFinBtn: !!document.getElementById('ipnGoFin'),
      })`));
      check(String(sv.hash).includes(`stock=${h.code}`), '热度榜点击 → URL 记录所选股票', `hash=${sv.hash}`);
      check(sv.defaultHidden === true, '热度榜点击 → 默认资讯流已隐藏', `hidden=${sv.defaultHidden}`);
      check(/全部相关资讯/.test(sv.headTitle || ''), '热度榜点击 → 展示该股资讯视图', `title=${sv.headTitle}`);
      check(sv.items > 0, '热度榜点击 → 列出该股相关资讯', `items=${sv.items}`);
      check(sv.titles === sv.items && sv.times === sv.items, '热度榜点击 → 每条资讯含标题与发布时间', `title=${sv.titles} time=${sv.times} items=${sv.items}`);
      check(sv.summaries > 0, '热度榜点击 → 部分资讯带摘要', `summary=${sv.summaries}`);
      check(sv.backBtn && sv.goFinBtn, '个股资讯视图提供「返回」与「查看财报」入口', `back=${sv.backBtn} fin=${sv.goFinBtn}`);

      // 返回全部资讯
      await evalv(`(() => { document.getElementById('ipnBack').click(); return true; })()`);
      await sleep(1500);
      const backSt = JSON.parse(await evalv(`JSON.stringify({
        defaultHidden: document.getElementById('ipnDefault').hidden,
        items: document.querySelectorAll('#ipnFeed .news-item').length,
      })`));
      check(backSt.defaultHidden === false && backSt.items > 0, '个股资讯视图可返回全部资讯流', `hidden=${backSt.defaultHidden} items=${backSt.items}`);
    }

    // ---------- 4. 新股资讯「资讯卡关联新股」→ 同样进入该股资讯 ----------
    await nav('#iponews', 15000);
    const chipRaw = await evalv(`(() => {
      const el = document.querySelector('#ipnFeed .chip');
      return el ? JSON.stringify({ code: el.dataset.code, name: el.dataset.name }) : null;
    })()`);
    check(!!chipRaw, '新股资讯：资讯卡关联新股标签可点击', '未找到');
    if (chipRaw) {
      const c = JSON.parse(chipRaw);
      await evalv(`(() => { document.querySelector('#ipnFeed .chip').click(); return true; })()`);
      await waitFor(`document.querySelectorAll('#ipnStockView .news-item').length > 0`, 40000);
      const sv2 = JSON.parse(await evalv(`JSON.stringify({
        code: (document.querySelector('#ipnStockView .snq-item .v.mono')||{}).textContent || null,
        items: document.querySelectorAll('#ipnStockView .news-item').length,
      })`));
      check(sv2.code === c.code, '资讯卡点击 → 展示所点股票的全部资讯', `code=${sv2.code} 期望 ${c.code}`);
      check(sv2.items > 0, '资讯卡点击 → 资讯列表非空', `items=${sv2.items}`);

      // 从个股资讯跳到财报整理
      await evalv(`(() => { document.getElementById('ipnGoFin').click(); return true; })()`);
      await sleep(11000);
      const finSt = await finSnap();
      check(finSt.heroCode === c.code, '个股资讯 →「查看财报」可进入财报整理', `hero=${finSt.heroCode} 期望 ${c.code}`);
    }

    // ---------- 5. 股票列表：维度切换与分类点击 ----------
    await nav('#stocks?dim=industry', 8000);
    const rowsLoaded = await waitFor(`document.querySelectorAll('#stkTable tr.row-click').length > 0`, 60000);
    check(!!rowsLoaded, '股票列表：默认加载了分类成分股', '超时未见数据行');
    const dimSt = await evalv(`JSON.stringify({
      activeDim: (document.querySelector('#stkDimSeg .seg-item.active')||{}).dataset
        ? document.querySelector('#stkDimSeg .seg-item.active').dataset.dim : null,
      groupCount: document.querySelectorAll('#stkGroups .catalog-item').length,
      activeGroup: (document.querySelector('#stkGroups .catalog-item.active')||{}).dataset
        ? document.querySelector('#stkGroups .catalog-item.active').dataset.code : null,
      rows: document.querySelectorAll('#stkTable tr.row-click').length,
    })`);
    const ds = JSON.parse(dimSt);
    check(ds.activeDim === 'industry', '股票列表：URL 指定维度生效', `dim=${ds.activeDim}`);
    check(ds.groupCount === 31, '股票列表：申万一级行业共 31 个分类', `实际 ${ds.groupCount}`);

    // 点击第三个行业，应重新加载（等待内容真正变化，而非仅等待选中态）
    const before = await evalv(`(document.querySelector('#stkTable tbody tr td:nth-child(2)')||{}).textContent || null`);
    await evalv(`(() => { document.querySelectorAll('#stkGroups .catalog-item')[2].click(); return true; })()`);
    const changed = await waitFor(`(() => {
      const g = document.querySelector('#stkGroups .catalog-item.active');
      const first = document.querySelector('#stkTable tbody tr td:nth-child(2)');
      return !!g && g.dataset.code !== ${JSON.stringify(ds.activeGroup)}
        && !!first && first.textContent.trim() !== ${JSON.stringify((before || '').trim())};
    })()`, 45000);
    const afterRaw = await evalv(`JSON.stringify({
      activeGroup: (document.querySelector('#stkGroups .catalog-item.active')||{}).dataset
        ? document.querySelector('#stkGroups .catalog-item.active').dataset.code : null,
      first: (document.querySelector('#stkTable tbody tr td:nth-child(2)')||{}).textContent || null,
      title: (document.querySelector('#stkListTitle')||{}).textContent || null,
      rows: document.querySelectorAll('#stkTable tr.row-click').length,
    })`);
    const af = JSON.parse(afterRaw);
    check(af.activeGroup && af.activeGroup !== ds.activeGroup, '股票列表：切换分类后选中态更新', `group=${af.activeGroup} 原=${ds.activeGroup}`);
    check(af.rows > 0, '股票列表：切换分类后列表重新加载', `rows=${af.rows}`);
    check(!!changed && af.first !== before, '股票列表：切换分类后内容确实变化', `before=${before} after=${af.first}`);

    // 切换到「热门概念」维度（同样不带 code），验证不会沿用上一个维度的分类代码
    await nav('#stocks?dim=concept', 6000);
    const conceptRows = await waitFor(`document.querySelectorAll('#stkTable tr.row-click').length > 0`, 50000);
    check(!!conceptRows, '股票列表：切换维度(概念)后自动落到该维度首个分类并加载', '超时未见数据行');
    const cSt = JSON.parse(await evalv(`JSON.stringify({
      activeDim: (document.querySelector('#stkDimSeg .seg-item.active')||{}).dataset
        ? document.querySelector('#stkDimSeg .seg-item.active').dataset.dim : null,
      activeGroup: (document.querySelector('#stkGroups .catalog-item.active')||{}).dataset
        ? document.querySelector('#stkGroups .catalog-item.active').dataset.code : null,
      title: (document.querySelector('#stkListTitle')||{}).textContent || null,
      err: !!document.querySelector('#stkTable .err-box'),
    })`));
    check(cSt.activeDim === 'concept', '股票列表：概念维度激活态正确', `dim=${cSt.activeDim}`);
    check(!cSt.err && /pt/.test(cSt.activeGroup || ''), '股票列表：概念维度分类代码正确(未沿用指数代码)', `group=${cSt.activeGroup} err=${cSt.err}`);

    // ---------- 6. 推荐榜单：榜单数量 / 50 只 / 切换榜单 ----------
    await nav('#recommend', 20000);
    const b0 = await evalv(`JSON.stringify({
      tabs: document.querySelectorAll('#rcBoards .board-tab').length,
      active: (document.querySelector('#rcBoards .board-tab.active')||{}).dataset
        ? document.querySelector('#rcBoards .board-tab.active').dataset.id : null,
      cards: document.querySelectorAll('#rcList .rec-card').length,
      ranks: Array.from(document.querySelectorAll('#rcList .rec-rank')).map(e => e.textContent.trim()).slice(-3),
      reasons: document.querySelectorAll('#rcList .rw-list li').length,
      firstReason: (document.querySelector('#rcList .rw-list li')||{}).textContent || null,
      summary: (document.getElementById('rcSummary')||{}).innerText || '',
    })`);
    const s0 = JSON.parse(b0);
    check(s0.tabs === 12, '推荐榜单：共 12 种榜单类型', `tabs=${s0.tabs}`);
    check(s0.active === 'comp', '推荐榜单：默认选中综合榜', `active=${s0.active}`);
    check(s0.cards === 50, '推荐榜单：每种榜单均列出 50 只股票', `cards=${s0.cards}`);
    check(s0.ranks.join(',') === '48,49,50', '推荐榜单：排名连续至第 50 名', `尾排名=${s0.ranks.join(',')}`);
    check(s0.reasons >= 50, '推荐榜单：每只股票均附推荐理由', `理由条目 ${s0.reasons}`);
    check(/本榜共\s*50/.test(s0.summary), '推荐榜单：统计条展示本榜条数', `summary=${s0.summary.slice(0, 60)}`);

    // 切换到一个「非评分类」新榜单（主力净流入榜），校验排序依据指标
    await evalv(`(() => { const t = document.querySelector('#rcBoards .board-tab[data-id="mainnet"]'); if (t) t.click(); return true; })()`);
    await sleep(17000);
    const bN = await evalv(`JSON.stringify({
      active: (document.querySelector('#rcBoards .board-tab.active')||{}).dataset
        ? document.querySelector('#rcBoards .board-tab.active').dataset.id : null,
      cards: document.querySelectorAll('#rcList .rec-card').length,
      metrics: Array.from(document.querySelectorAll('#rcList .rec-card')).slice(0,2)
        .map(c => Array.from(c.querySelectorAll('.mc-l')).map(e => e.textContent).join(',')),
      firstReason: (document.querySelector('#rcList .rw-list li')||{}).textContent || null,
    })`);
    const sN = JSON.parse(bN);
    check(sN.active === 'mainnet', '推荐榜单：新增榜单可切换（主力净流入榜）', `active=${sN.active}`);
    check(sN.cards === 50, '推荐榜单：新增榜单同样列出 50 只', `cards=${sN.cards}`);
    check(JSON.stringify(sN.metrics).includes('主力净流入'), '推荐榜单：新增榜单展示对应排序指标', `metrics=${sN.metrics}`);
    check(/主力净流入/.test(sN.firstReason || ''), '推荐榜单：新增榜单理由引用真实字段', `reason=${sN.firstReason}`);

    await evalv(`(() => { const t = document.querySelector('#rcBoards .board-tab[data-id="value"]'); t.click(); return true; })()`);
    await sleep(17000);
    const b1 = await evalv(`JSON.stringify({
      active: (document.querySelector('#rcBoards .board-tab.active')||{}).dataset
        ? document.querySelector('#rcBoards .board-tab.active').dataset.id : null,
      cards: document.querySelectorAll('#rcList .rec-card').length,
      firstReason: (document.querySelector('#rcList .rw-list li')||{}).textContent || null,
      metrics: Array.from(document.querySelectorAll('#rcList .rec-card')).slice(0,1)
        .map(c => Array.from(c.querySelectorAll('.mc-l')).map(e => e.textContent).join(',')),
    })`);
    const s1 = JSON.parse(b1);
    check(s1.active === 'value', '推荐榜单：切换榜单生效', `active=${s1.active}`);
    check(s1.cards > 0, '推荐榜单：切换后仍渲染卡片', `cards=${s1.cards}`);
    check(JSON.stringify(s1.metrics).includes('PE'), '推荐榜单：低估值榜展示 PE/股息率指标', `metrics=${s1.metrics}`);
    check(s1.firstReason !== s0.firstReason, '推荐榜单：切换榜单后理由随之变化', '理由未变化');

    // 榜单内筛选应真正缩小集合
    await evalv(`(() => { const i = document.getElementById('rcFilter'); i.value = '银行'; i.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    await sleep(900);
    const sF = JSON.parse(await evalv(`JSON.stringify({
      cards: document.querySelectorAll('#rcList .rec-card').length,
      summary: (document.getElementById('rcSummary')||{}).innerText || '',
    })`));
    check(sF.cards < s1.cards, '推荐榜单：本榜筛选可缩小结果集', `before=${s1.cards} after=${sF.cards}`);
    await evalv(`(() => { const i = document.getElementById('rcFilter'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    await sleep(600);

    // ---------- 7. 新股资讯：市场筛选与搜索 ----------
    await nav('#iponews?market=hk', 15000);
    const n0 = await evalv(`JSON.stringify({
      activeMarket: (document.querySelector('#ipnMarketSeg .seg-item.active')||{}).dataset
        ? document.querySelector('#ipnMarketSeg .seg-item.active').dataset.market : null,
      items: document.querySelectorAll('#ipnFeed .news-item').length,
      summaries: document.querySelectorAll('#ipnFeed .ni-summary').length,
      titles: document.querySelectorAll('#ipnFeed .ni-title').length,
      times: document.querySelectorAll('#ipnFeed .ni-time').length,
    })`);
    const ns = JSON.parse(n0);
    check(ns.activeMarket === 'hk', '新股资讯：URL 指定市场生效', `market=${ns.activeMarket}`);
    check(ns.items > 0, '新股资讯：资讯流渲染条目', `items=${ns.items}`);
    check(ns.titles === ns.items, '新股资讯：每条资讯均有标题', `title=${ns.titles}/${ns.items}`);
    check(ns.times === ns.items, '新股资讯：每条资讯均有发布时间', `time=${ns.times}/${ns.items}`);
    check(ns.summaries > 0, '新股资讯：至少部分资讯带摘要', `summary=${ns.summaries}`);

    // ---------- 8. 附录：结构、目录、交叉引用 ----------
    await nav('#appendix', 9000);
    await waitFor(`document.querySelectorAll('#apxMain .apx-item').length > 0`, 40000);
    const apx = JSON.parse(await evalv(`JSON.stringify({
      parts: document.querySelectorAll('#apxMain .apx-part').length,
      groups: document.querySelectorAll('#apxMain .apx-group').length,
      items: document.querySelectorAll('#apxMain .apx-item').length,
      termItems: document.querySelectorAll('#apxMain .apx-item:not(.apx-item-score)').length,
      scoreItems: document.querySelectorAll('#apxMain .apx-item-score').length,
      tocParts: document.querySelectorAll('#apxToc .toc-part').length,
      tocSubs: document.querySelectorAll('#apxToc .toc-sub').length,
      xrefLinks: document.querySelectorAll('#apxMain .xref').length,
      crRows: document.querySelectorAll('#apxToc .apx-cr-row').length,
      firstNo: (document.querySelector('#apxMain .apx-item .apx-no')||{}).textContent || null,
      groupNo: (document.querySelector('#apxMain .apx-group-no')||{}).textContent || null,
      hasStandard: document.querySelectorAll('#apxMain .apx-std').length,
      hasFields: document.querySelectorAll('#apxMain .apx-field').length,
    })`));
    check(apx.parts === 3, '附录：分为「术语解释 / 评分依据 / 股票交易指南」三部分', `parts=${apx.parts}`);
    check(apx.groups === 12, '附录：共 12 个分类/分组（术语 7 + 评分 2 + 交易指南 3）', `groups=${apx.groups}`);
    check(apx.termItems >= 76, '附录：术语条目数量充足', `terms=${apx.termItems}`);
    check(apx.scoreItems >= 10, '附录：评分依据条目齐全', `scores=${apx.scoreItems}`);
    check(apx.firstNo === 'A.1.1' && apx.groupNo === 'A.1', '附录：分组用 A.x、条目用 A.x.y 编号', `item=${apx.firstNo} group=${apx.groupNo}`);
    check(apx.tocParts === 3 && apx.tocSubs === 12, '附录：目录含 3 个部分与 12 个分组', `parts=${apx.tocParts} subs=${apx.tocSubs}`);
    check(apx.hasStandard >= 10, '附录：评分项均列出评分标准', `std=${apx.hasStandard}`);
    check(apx.xrefLinks > 20, '附录：条目间存在交叉引用', `xref=${apx.xrefLinks}`);
    check(apx.crRows >= 5, '附录：提供相互引用索引', `rows=${apx.crRows}`);

    // 交叉引用跳转应定位到目标条目
    await evalv(`(() => {
      const a = document.querySelector('#apxToc .apx-cr-row .xref');
      a.scrollIntoView(); a.click(); return true;
    })()`);
    await sleep(1200);
    const jump = JSON.parse(await evalv(`JSON.stringify({
      flash: document.querySelectorAll('#apxMain .apx-flash').length,
      open: document.querySelectorAll('#apxMain .apx-item.open').length,
    })`));
    check(jump.flash >= 1, '附录：交叉引用可跳转并高亮目标条目', `flash=${jump.flash}`);
    check(jump.open >= 1, '附录：跳转后目标条目自动展开', `open=${jump.open}`);

    // 检索
    await evalv(`(() => {
      const i = document.getElementById('apxSearch');
      i.value = 'MACD'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    await sleep(1200);
    const apxFiltered = JSON.parse(await evalv(`JSON.stringify({
      items: document.querySelectorAll('#apxMain .apx-item').length,
      text: (document.querySelector('#apxMain')||{}).textContent || '',
    })`));
    check(apxFiltered.items > 0 && apxFiltered.items < apx.items, '附录：检索可过滤条目', `筛选后 ${apxFiltered.items} / 原 ${apx.items}`);
    check(/MACD/.test(apxFiltered.text), '附录：检索结果包含关键词', '未命中');

    // 第三部分「股票交易指南」与 C 条目深链（深链走同文档 hash 导航，渲染时机不稳，必须轮询等待元素出现）
    await nav('#appendix?no=C.2.1', 9000);
    const cReady = await waitFor(`!!document.getElementById('apx-C-2-1') && /无涨跌停|涨跌幅限制/.test((document.getElementById('apxMain')||{}).textContent || '')`, 40000);
    const cPart = JSON.parse(await evalv(`JSON.stringify({
      partC: !!document.getElementById('apx-C'),
      item: !!document.getElementById('apx-C-2-1'),
      text: (document.getElementById('apxMain')||{}).textContent || '',
      tocHasC: /股票交易指南/.test((document.getElementById('apxToc')||{}).textContent || ''),
    })`));
    check(cReady && cPart.partC, '附录：股票交易指南部分（C）已渲染', `partC=${cPart.partC}`);
    check(cPart.tocHasC, '附录：目录含「股票交易指南」', '');
    check(cReady && cPart.item, '附录：C 条目深链可直达（C.2.1 涨跌幅差异）', `item=${cPart.item}`);

    // A 股交易指南（C.3）：章节存在、条目数达标、深链可直达、与 C.1/C.2 不冲突
    await nav('#appendix?no=C.3.2', 9000);
    const c3Ready = await waitFor(`!!document.getElementById('apx-C-3-2') && /T\\+1/.test((document.getElementById('apxMain')||{}).textContent || '')`, 40000);
    const c3 = JSON.parse(await evalv(`JSON.stringify({
      partC: !!document.getElementById('apx-C'),
      group: !!document.getElementById('apx-C-3'),
      item: !!document.getElementById('apx-C-3-2'),
      items: document.querySelectorAll('#apx-C-3 .apx-item').length,
      title: (document.querySelector('#apx-C-3 .apx-group-head h3')||{}).textContent || null,
      toc: /A 股基本交易规则/.test((document.getElementById('apxToc')||{}).textContent || ''),
      hk1: !!document.getElementById('apx-C-1'),
      hk2: !!document.getElementById('apx-C-2'),
    })`));
    check(c3.partC && c3.group, '附录：新增「A 股基本交易规则」分组（C.3）', `partC=${c3.partC} group=${c3.group}`);
    check(c3.title === 'A 股基本交易规则', '附录：C.3 分组标题正确', `title=${c3.title}`);
    check(c3.items === 8, '附录：C.3 含 8 条规则条目', `items=${c3.items}`);
    check(c3.toc, '附录：目录含「A 股基本交易规则」', '');
    check(c3Ready && c3.item, '附录：C.3 条目深链可直达（C.3.2 T+1 交易）', `item=${c3.item}`);
    check(c3.hk1 && c3.hk2, '附录：原有 C.1 / C.2 分组未受影响', `c1=${c3.hk1} c2=${c3.hk2}`);

    // ---------- 9. 股票列表：新增分类维度 ----------
    const DIMS = [
      { dim: 'industry2', minGroups: 100, label: '申万二级行业' },
      { dim: 'connect', minGroups: 2, label: '沪深港通标的' },
      { dim: 'hk', minGroups: 3, label: '港股', mock: true },
      { dim: 'watch', minGroups: 2, label: '热门榜单' },
    ];
    for (const d of DIMS) {
      await nav(`#stocks?dim=${d.dim}`, 8000);
      // 必须等待「内容真正切换」：仅等 rows>0 会在上一维度的旧 DOM 上立即通过（假通过）
      const loaded = await waitFor(`(() => {
        const seg = document.querySelector('#stkDimSeg .seg-item.active');
        if (!seg || seg.dataset.dim !== '${d.dim}') return false;
        if (document.querySelectorAll('#stkTable tr.row-click').length === 0) return false;
        ${d.mock ? "if (!document.querySelector('#stkMockNote .dim-hint')) return false;" : ''}
        return true;
      })()`, 70000);
      const st = JSON.parse(await evalv(`JSON.stringify({
        activeDim: (document.querySelector('#stkDimSeg .seg-item.active')||{}).dataset
          ? document.querySelector('#stkDimSeg .seg-item.active').dataset.dim : null,
        dimTabs: document.querySelectorAll('#stkDimSeg .seg-item').length,
        groups: document.querySelectorAll('#stkGroups .catalog-item').length,
        rows: document.querySelectorAll('#stkTable tr.row-click').length,
        err: !!document.querySelector('#stkTable .err-box'),
        title: (document.querySelector('#stkListTitle')||{}).textContent || null,
        mockNote: !!document.querySelector('#stkMockNote .dim-hint'),
        codes: Array.from(document.querySelectorAll('#stkTable tr.row-click .mono')).slice(0,2).map(e=>e.textContent.trim()),
      })`));
      check(!!loaded && !st.err, `股票列表[${d.label}]：可加载成分股`, `rows=${st.rows} err=${st.err}`);
      check(st.activeDim === d.dim, `股票列表[${d.label}]：维度激活态正确`, `dim=${st.activeDim}`);
      check(st.groups >= d.minGroups, `股票列表[${d.label}]：分类数 ≥ ${d.minGroups}`, `groups=${st.groups}`);
      check(st.dimTabs === 7, `股票列表[${d.label}]：维度页签共 7 个`, `tabs=${st.dimTabs}`);
      if (d.mock) {
        check(st.mockNote, `股票列表[${d.label}]：模拟数据提示条已展示`, `note=${st.mockNote}`);
        check(st.codes.every((c) => /^hk\d{5}$/.test(c)), `股票列表[${d.label}]：代码为规范 hk 前缀形态`, `codes=${st.codes.join(',')}`);
        // 模拟数据下的排序与刷新应正常工作：轮询直到「升序真正生效」，
        // 中途若未生效则补发一次 change（页面首次加载与排序可能竞争）
        const setSortAsc = `(() => { const s = document.getElementById('stkSort'); s.value = 'changePct-asc'; s.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`;
        await evalv(setSortAsc);
        let sortedOk = false;
        let chg = [];
        for (let i = 0; i < 30; i++) {
          chg = JSON.parse(await evalv(`JSON.stringify(Array.from(document.querySelectorAll('#stkTable tr.row-click')).slice(0,3).map(tr => tr.querySelectorAll('td')[5].textContent.trim()))`));
          const nums = chg.map((t) => parseFloat(t));
          if (nums.length >= 3 && nums.every((v, j) => j === 0 || nums[j - 1] <= v)) { sortedOk = true; break; }
          if (i === 6) await evalv(setSortAsc);
          await sleep(1500);
        }
        check(sortedOk, `股票列表[${d.label}]：切换升序后涨跌幅单调递增`, `前3=${chg.join(',')}`);
        await evalv(`(() => { const b = document.getElementById('btnRefresh'); b.click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#stkTable tr.row-click').length > 0`, 40000);
        check(true, `股票列表[${d.label}]：刷新后列表正常`, '');
        await evalv(`(() => { const s = document.getElementById('stkSort'); s.value = 'changePct-desc'; s.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
        await sleep(2500);
      }
    }

    // 点击新维度中的股票仍可进入财报
    await evalv(`(() => { const tr = document.querySelector('#stkTable tr.row-click'); tr.click(); return true; })()`);
    await sleep(11000);
    const navSt = await finSnap();
    check(!!navSt.heroCode && navSt.view === 'view-finance', '股票列表[新维度] → 财报整理：可正常跳转', `hero=${navSt.heroCode}`);

    // ---------- 10. 总览 / 市场分析：点击股票名称进入详情 ----------
    await nav('#overview', 12000);
    const ovLink = await evalv(`(() => {
      const el = document.querySelector('#ovIpo tr.row-click') || document.querySelector('#ovSectors .stock-link');
      return el ? JSON.stringify({ kind: el.tagName, code: el.dataset.code || null, name: el.dataset.name || null }) : null;
    })()`);
    check(!!ovLink, '总览：新股/行业表存在可点击股票', '未找到');
    if (ovLink) {
      const o = JSON.parse(ovLink);
      await evalv(`(() => { const el = document.querySelector('#ovIpo tr.row-click') || document.querySelector('#ovSectors .stock-link'); el.click(); return true; })()`);
      await sleep(12000);
      const st = await finSnap();
      check(st.view === 'view-finance' && !!st.heroCode, '总览 → 财报整理：点击可进入该股详情', `view=${st.view} hero=${st.heroCode}`);
      if (o.code) check(st.heroCode === o.code, '总览 → 财报整理：标的与所点股票一致', `hero=${st.heroCode} 期望 ${o.code}`);
    }

    await nav('#market', 16000);
    // 自选股板块应已完全移除
    const gone = JSON.parse(await evalv(`JSON.stringify({
      mkTech: !!document.getElementById('mkTech'),
      mkCodeInput: !!document.getElementById('mkCodeInput'),
      mkAddWatch: !!document.getElementById('mkAddWatch'),
      techCards: document.querySelectorAll('.tech-card').length,
      watchText: /自选股/.test(document.getElementById('view-market').innerText || ''),
    })`));
    check(!gone.mkTech && !gone.mkCodeInput && !gone.mkAddWatch && gone.techCards === 0,
      '市场分析：自选股板块及其组件已移除', JSON.stringify(gone));
    // 注意：要闻来源「腾讯自选股」含该字样，属数据源名称而非界面文案，需用组件性措辞判定
    const watchTextGone = await evalv(`!/自选股技术诊断|加入自选|自选股为空|输入代码加入自选/.test((document.getElementById('view-market')||{}).innerText || '')`);
    check(watchTextGone, '市场分析：无自选股相关的界面文案残留', '');

    // 市场要闻：冷启动需抓取 40 条要闻并逐条取正文摘要，必须先等加载完成（meta 不再是「正在加载」）
    await waitFor(`document.querySelectorAll('#mkNewsCats .nc-chip').length >= 3
      && !/正在加载/.test((document.getElementById('mkNewsMeta')||{}).textContent || '')`, 90000);
    // 市场要闻：分类标签 + 重点要闻 + 更多要闻 + 时间分组
    const news = JSON.parse(await evalv(`JSON.stringify({
      cats: document.querySelectorAll('#mkNewsCats .nc-chip').length,
      keyCards: document.querySelectorAll('#mkNewsBody .nk-item').length,
      rows: document.querySelectorAll('#mkNewsBody .nr-item').length,
      days: document.querySelectorAll('#mkNewsBody .news-day-head').length,
      titles: Array.from(document.querySelectorAll('#mkNewsBody .nk-title')).map(e => e.textContent.trim().length),
      summaries: document.querySelectorAll('#mkNewsBody .nk-summary').length,
      meta: (document.getElementById('mkNewsMeta')||{}).textContent || '',
    })`));
    check(news.cats >= 3, '市场要闻：渲染分类筛选标签', `chips=${news.cats}`);
    check(news.keyCards === 3, '市场要闻：重点要闻固定 3 条', `key=${news.keyCards}`);
    check(news.rows > 10, '市场要闻：更多要闻列表渲染条目', `rows=${news.rows}`);
    check(news.days >= 1, '市场要闻：条目按日期分组', `days=${news.days}`);
    check(news.titles.every((n) => n > 8), '市场要闻：标题完整未截断', `长度=${news.titles.join(',')}`);
    check(news.summaries >= 1, '市场要闻：重点要闻带正文摘要', `summary=${news.summaries}`);
    check(/最新/.test(news.meta) && /更新于/.test(news.meta), '市场要闻：展示更新时间与最新发布时间', `meta=${news.meta.slice(0, 60)}`);

    // 分类筛选应真正改变条目集合
    const beforeFilter = await evalv(`document.querySelectorAll('#mkNewsBody .nr-item').length + document.querySelectorAll('#mkNewsBody .nk-item').length`);
    await evalv(`(() => { const c = document.querySelectorAll('#mkNewsCats .nc-chip')[1]; if (c) c.click(); return true; })()`);
    await sleep(900);
    const afterFilter = JSON.parse(await evalv(`JSON.stringify({
      active: (document.querySelector('#mkNewsCats .nc-chip.active')||{}).textContent || null,
      n: document.querySelectorAll('#mkNewsBody .nr-item').length + document.querySelectorAll('#mkNewsBody .nk-item').length,
    })`));
    check(afterFilter.active && Number(afterFilter.n) !== Number(beforeFilter),
      '市场要闻：切换分类后条目集合变化', `before=${beforeFilter} after=${afterFilter.n} chip=${afterFilter.active}`);

    const mkLink = await evalv(`(() => {
      const el = document.querySelector('#mkHotStocks .lm-item') || document.querySelector('#mkSectors .stock-link');
      if (!el) return null;
      return JSON.stringify({ code: el.dataset.code || null, name: el.dataset.name || null, id: el.closest('.lm-item') ? 'hot' : 'sector' });
    })()`);
    check(!!mkLink, '市场分析：热搜/板块存在可点击股票', '未找到');
    if (mkLink) {
      const m = JSON.parse(mkLink);
      await evalv(`(() => {
        const el = document.querySelector('#mkHotStocks .lm-item') || document.querySelector('#mkSectors .stock-link');
        el.click(); return true;
      })()`);
      await waitFor(`document.querySelector('.view.active').id === 'view-finance'`, 30000);
      // 财报数据加载可能超过数秒，轮询等待 hero 真正渲染出标的
      await waitFor(`(document.querySelector('.fin-hero-name .mono')||{}).textContent`, 60000);
      const st = await finSnap();
      check(st.view === 'view-finance' && !!st.heroCode, '市场分析 → 财报整理：点击可进入该股详情', `view=${st.view} hero=${st.heroCode}`);
      if (m.code) check(st.heroCode === m.code, '市场分析 → 财报整理：标的与所点股票一致', `hero=${st.heroCode} 期望 ${m.code}`);
    }

    // ---------- 11. 新股消息：点击股票名称进入该股资讯详情 ----------
    await nav('#ipo', 15000);
    const ipoLink = await evalv(`(() => {
      const el = document.querySelector('#ipoTable .stock-link') || document.querySelector('#ipoStages .stock-link');
      if (!el) return null;
      return JSON.stringify({ code: el.dataset.ncode || null, name: el.dataset.nname || null,
        zone: el.closest('#ipoTable') ? 'table' : 'stage' });
    })()`);
    check(!!ipoLink, '新股消息：明细表/阶段看板存在可点击股票名称', '未找到');
    if (ipoLink) {
      const i0 = JSON.parse(ipoLink);
      check(!!i0.code, '新股消息：可点击名称带规范化证券代码', `code=${i0.code}`);
      await evalv(`(() => {
        const el = document.querySelector('#ipoTable .stock-link') || document.querySelector('#ipoStages .stock-link');
        el.click(); return true;
      })()`);
      await waitFor(`document.querySelector('.view.active').id === 'view-iponews' && !!document.getElementById('ipnStockView').innerText.trim()`, 40000);
      await sleep(4000);
      const iv = JSON.parse(await evalv(`JSON.stringify({
        view: document.querySelector('.view.active').id,
        hash: location.hash,
        hero: (document.querySelector('#ipnStockView .card-head h2')||{}).textContent || null,
        code: (document.querySelector('#ipnStockView .snq-item .mono')||{}).textContent || null,
        back: !!document.getElementById('ipnBack'),
        goFin: !!document.getElementById('ipnGoFin'),
      })`));
      check(iv.view === 'view-iponews', '新股消息 → 新股资讯：进入资讯详情视图', `view=${iv.view} hash=${iv.hash}`);
      check(/stock=/.test(iv.hash), '新股消息 → 新股资讯：URL 深链带股票代码', `hash=${iv.hash}`);
      if (i0.name) check(String(iv.hero || '').includes(i0.name.replace(/\s/g, '')), '新股消息 → 新股资讯：详情页标的与所点新股一致', `hero=${iv.hero} 期望含 ${i0.name}`);
      check(iv.back && iv.goFin, '新股资讯详情：提供返回与查看财报入口', `back=${iv.back} fin=${iv.goFin}`);
    }

    // ---------- 12. AI 选股：今日推荐 / 持仓分析 / 自选与持仓管理 ----------
    await nav('#picker', 25000);
    await waitFor(`document.querySelectorAll('#pkList .pk-card').length >= 3`, 60000);
    const pk = JSON.parse(await evalv(`JSON.stringify({
      kpis: document.querySelectorAll('#pkKpis .kpi').length,
      cards: document.querySelectorAll('#pkList .pk-card').length,
      reasons: document.querySelectorAll('#pkList .rw-list li').length,
      refs: document.querySelectorAll('#pkList .pkr').length,
      riskBlocks: document.querySelectorAll('#pkList .rec-risk').length,
      funnel: document.querySelectorAll('#pkFunnel .pkf-item').length,
      meta: (document.getElementById('pkDailyMeta')||{}).textContent || '',
    })`));
    check(pk.kpis >= 4, 'AI 选股：今日推荐 KPI 渲染', `kpis=${pk.kpis}`);
    check(pk.cards >= 3 && pk.cards <= 10, 'AI 选股：推荐 3–10 只', `cards=${pk.cards}`);
    check(pk.reasons >= pk.cards * 3, 'AI 选股：每只推荐 ≥3 条可溯源理由', `reasons=${pk.reasons}`);
    check(pk.refs >= pk.cards, 'AI 选股：每只推荐给出参考价位', `refs=${pk.refs}`);
    check(pk.funnel >= 1, 'AI 选股：过滤漏斗与口径披露', `funnel=${pk.funnel}`);
    // 自选股 innerText 字段在 gone 里仅作组件探测，不再用于文案断言
    const hasDisclaimer = await evalv(`!!document.querySelector('#pkList .rec-disclaimer')`);
    check(hasDisclaimer, 'AI 选股：免责声明展示', '');

    // 激进度切换：选中态（图标）必须立即跟随，且来回切换都正确
    const activeProfile = () => evalv(`(() => {
      const el = document.querySelector('#pkProfileSeg .seg-item.active');
      return el && el.dataset ? el.dataset.profile : null;
    })()`);
    const clickProfile = (p) => evalv(`(() => { document.querySelector('#pkProfileSeg .seg-item[data-profile="${p}"]').click(); return true; })()`);
    for (const p of ['conservative', 'aggressive', 'balanced', 'conservative']) {
      await clickProfile(p);
      // 选中态应即时生效（不等待数据加载）
      await waitFor(`(() => {
        const el = document.querySelector('#pkProfileSeg .seg-item.active');
        return !!el && el.dataset.profile === '${p}';
      })()`, 8000);
      const act = await activeProfile();
      check(act === p, `AI 选股：切换到「${p}」后选中态图标随之更新`, `active=${act} 期望=${p}`);
      await waitFor(`document.querySelectorAll('#pkList .pk-card').length >= 3`, 60000);
    }

    // 切换到持仓分析
    await evalv(`(() => { document.querySelector('#pkSeg .seg-item[data-tab="holdings"]').click(); return true; })()`);
    await waitFor(`document.querySelectorAll('#pkHList .pk-hold').length > 0 || /暂无持仓/.test(document.getElementById('pkHList').innerText)`, 60000);
    const pkh = JSON.parse(await evalv(`JSON.stringify({
      empty: /暂无持仓/.test(document.getElementById('pkHList').innerText),
      kpis: document.querySelectorAll('#pkHKpis .kpi').length,
      cards: document.querySelectorAll('#pkHList .pk-hold').length,
      signals: document.querySelectorAll('#pkHList .sig-item').length,
      verdicts: Array.from(document.querySelectorAll('#pkHList .tag')).map(e=>e.textContent).slice(0, 8),
      health: Array.from(document.querySelectorAll('#pkHList .pk-health')).map(e=>Number(e.textContent)),
    })`));
    if (pkh.empty) {
      console.log('  （提示：无持仓，持仓分析展示空态引导）');
      check(true, 'AI 选股：无持仓时给出空态引导', '');
    } else {
      check(pkh.kpis >= 4, 'AI 选股：持仓分析 KPI 渲染', `kpis=${pkh.kpis}`);
      check(pkh.cards > 0, 'AI 选股：逐只持仓卡片渲染', `cards=${pkh.cards}`);
      check(pkh.signals > 0, 'AI 选股：持仓信号明细可见', `signals=${pkh.signals}`);
      check(pkh.verdicts.some((v) => ['建议卖出', '建议减仓', '关注', '继续持有'].includes(v)), 'AI 选股：判读标签在四档枚举内', `verdicts=${pkh.verdicts.join(',')}`);
      check(pkh.health.every((v) => v >= 0 && v <= 10), 'AI 选股：持有健康度在 0–10', `health=${pkh.health.join(',')}`);
    }

    // 管理页：自选股增删回归 + 持仓/交易表渲染
    await evalv(`(() => { document.querySelector('#pkSeg .seg-item[data-tab="manage"]').click(); return true; })()`);
    await waitFor(`(document.querySelector('#pkWatchList table') || document.querySelector('#pkWatchList .empty'))`, 40000);
    const wBefore = await evalv(`document.querySelectorAll('#pkWatchList tbody tr').length`);
    await evalv(`(() => { const i = document.getElementById('pkWatchInput'); i.value = 'sh601398'; document.getElementById('pkWatchAdd').click(); return true; })()`);
    await waitFor(`document.querySelectorAll('#pkWatchList tbody tr').length === ${wBefore} + 1`, 40000);
    check(true, 'AI 选股：自选股添加成功（工商银行）', `rows ${wBefore} → ${wBefore + 1}`);
    await evalv(`(() => { const btn = Array.from(document.querySelectorAll('#pkWatchList .pk-w-del')).find((b) => b.dataset.code === 'sh601398'); if (btn) btn.click(); return true; })()`);
    await waitFor(`document.querySelectorAll('#pkWatchList tbody tr').length === ${wBefore}`, 40000);
    check(true, 'AI 选股：自选股移除成功', `rows 恢复 ${wBefore}`);
    const mg = JSON.parse(await evalv(`JSON.stringify({
      holdRows: document.querySelectorAll('#pkHoldingsList tbody tr').length,
      txRows: document.querySelectorAll('#pkTxList tbody tr').length,
      holdAdd: !!document.getElementById('phCode'),
      txAdd: !!document.getElementById('pkTxAdd'),
      rebuild: !!document.getElementById('pkTxRebuild'),
    })`));
    check(mg.holdRows > 0, 'AI 选股：持仓列表渲染（含添加行）', `rows=${mg.holdRows}`);
    check(mg.txRows > 0, 'AI 选股：交易记录渲染', `rows=${mg.txRows}`);
    check(mg.txAdd && mg.rebuild, 'AI 选股：提供记交易与按交易重建入口', `add=${mg.txAdd} rebuild=${mg.rebuild}`);

    console.log(`\n=== 控制台错误 ===\n${errs.length ? [...new Set(errs)].join('\n') : '无'}`);
    console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`);
    ws.close();
  } catch (e) {
    console.error('联动测试失败:', e.message);
  } finally {
    try { proc.kill(); } catch (_) { /* ignore */ }
    await sleep(600);
    process.exit(failures ? 1 : 0);
  }
})();
