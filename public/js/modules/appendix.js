/* modules/appendix.js — 附录：术语解释 + 评分依据 */
(function () {
  'use strict';
  const { $, $$, setHtml, esc, empty, errorBox, toast } = UI;

  const state = { data: null, keyword: '', openIds: null };

  const domId = (no) => `apx-${String(no).replace(/\./g, '-')}`;

  // ============================================================
  // 数据索引：编号 → 条目，供交叉引用查找
  // ============================================================
  function buildIndex(data) {
    const index = {};
    (data.parts || []).forEach((part) => {
      if (part.id === 'terms') {
        (part.categories || []).forEach((cat) => {
          (cat.items || []).forEach((it) => {
            index[it.no] = { kind: 'term', no: it.no, title: it.term, parent: `${part.no} ${part.title} › ${cat.no} ${cat.title}`, partId: part.id, catId: cat.id };
          });
        });
      } else {
        (part.groups || []).forEach((grp) => {
          (grp.items || []).forEach((it) => {
            index[it.no] = { kind: 'score', no: it.no, title: it.name, parent: `${part.no} ${part.title} › ${grp.no} ${grp.title}`, partId: part.id, grpId: grp.id };
          });
        });
      }
    });
    return index;
  }

  function xref(no, index) {
    const t = index[no];
    const label = t ? `${no} ${t.title}` : no;
    return `<a class="xref" data-ref="${esc(no)}" title="${esc(t ? t.parent + ' › ' + t.title : no)}">${esc(label)}</a>`;
  }

  // ============================================================
  // 渲染
  // ============================================================
  async function render(sub, params) {
    if (!state.data) {
      state.data = await UI.task(() => API.appendix(), { loadingText: '正在加载附录…' });
      state.index = buildIndex(state.data);
      state.openIds = new Set();
      (state.data.parts || []).forEach((p) => state.openIds.add(p.no));
    }
    // 深链直达：#appendix?no=A.3.5
    // 深链是显式导航动作，必须在渲染**前**清除残留的检索过滤——否则目标条目
    // 可能正被旧关键词过滤隐藏，jumpTo 找不到元素而静默失败（同文档 hash 导航时 state 会保留）
    if (params && params.no) {
      state.keyword = '';
      const inp = document.getElementById('apxSearch');
      if (inp) inp.value = '';
    }
    bindOnce();
    drawToc();
    drawMain();
    if (params && params.no) {
      setTimeout(() => jumpTo(domId(params.no)), 260);
    }
  }

  function drawToc() {
    const d = state.data;
    const toc = d.parts.map((part) => {
      const subs = part.id === 'terms'
        ? part.categories.map((c) => ({ no: c.no, title: c.title, id: domId(c.no), count: c.items.length, kind: 'cat' }))
        : part.groups.map((g) => ({ no: g.no, title: g.title, id: domId(g.no), count: g.items.length, kind: 'grp' }));
      return `
        <div class="toc-part">
          <button class="toc-part-head" data-jump="${esc(domId(part.no))}">
            <span class="toc-no">${esc(part.no)}</span>${esc(part.title)}
            <span class="toc-cnt">${subs.reduce((s, x) => s + x.count, 0)}</span>
          </button>
          <div class="toc-subs">
            ${subs.map((s) => `<button class="toc-sub" data-jump="${esc(s.id)}"><span class="toc-no">${esc(s.no)}</span>${esc(s.title)}<span class="toc-cnt">${s.count}</span></button>`).join('')}
          </div>
        </div>`;
    }).join('');

    setHtml('apxToc', `
      <div class="card-head" style="margin-bottom:10px"><h2>目录</h2></div>
      <p class="apx-toc-note">${esc((state.data.meta || {}).structure || '')}</p>
      ${toc}
      <div class="apx-cr">
        <div class="apx-cr-head">相互引用索引</div>
        ${(state.data.crossRefs || []).map((c) => `<div class="apx-cr-row">
          <a class="xref" data-ref="${esc(c.from)}">${esc(c.from)}</a>
          <span class="cr-arrow">→</span>
          <a class="xref" data-ref="${esc(c.to)}">${esc(c.to)}</a>
          <div class="cr-note">${esc(c.note)}</div>
        </div>`).join('')}
      </div>`);

    $$('#apxToc [data-jump]').forEach((b) => b.addEventListener('click', () => jumpTo(b.dataset.jump)));
    bindXrefs($('#apxToc'));
  }

  function drawMain() {
    const d = state.data;
    const kw = state.keyword.trim().toLowerCase();

    const partsHtml = d.parts.map((part) => {
      const isTerms = part.id === 'terms';
      const groups = isTerms ? part.categories : part.groups;

      const rendered = groups.map((g) => {
        const items = (g.items || []).filter((it) => {
          if (!kw) return true;
          const hay = [
            it.no, it.term, it.name, it.en, it.meaning, it.scene, it.logic, it.source, it.where, it.range,
            (it.standard || []).join(' '), (it.related || []).join(' '),
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(kw);
        });
        if (!items.length) return '';
        return `
          <section class="apx-group" id="${esc(domId(g.no))}">
            <div class="apx-group-head">
              <span class="apx-group-no">${esc(g.no)}</span>
              <h3>${esc(g.title)}</h3>
              <span class="apx-count">${items.length} 项</span>
            </div>
            ${g.desc ? `<p class="apx-group-desc">${esc(g.desc)}</p>` : ''}
            <div class="apx-items">
              ${items.map((it) => (it.name ? renderScore(it) : renderTerm(it))).join('')}
            </div>
          </section>`;
      }).filter(Boolean).join('');

      if (!rendered) return '';

      return `
        <section class="apx-part" id="${esc(domId(part.no))}">
          <div class="apx-part-head">
            <span class="apx-part-no">${esc(part.no)}</span>
            <h2>${esc(part.title)}</h2>
          </div>
          ${part.intro ? `<p class="apx-part-intro">${esc(part.intro)}</p>` : ''}
          ${rendered}
        </section>`;
    }).filter(Boolean).join('');

    const m = d.meta || {};
    setHtml('apxMain', `
      <div class="card apx-meta" id="apxMetaHost">
        <div class="card-head"><h2>${esc(m.title || '附录')}</h2>
          <span class="card-sub">版本 ${esc(m.version || '—')}</span></div>
        <p class="apx-meta-p">${esc(m.scope || '')}</p>
        <p class="apx-meta-p">${esc(m.structure || '')}</p>
        <div class="apx-legend">
          ${(m.readingGuide || []).map((x) => `<span class="apx-legend-item"><b>${esc(x.k)}</b>${esc(x.v)}</span>`).join('')}
        </div>
        <p class="apx-meta-src">数据来源：${esc(m.source || '')}</p>
      </div>
      ${partsHtml || `<div class="card">${empty('没有匹配的条目', '🔍')}</div>`}`);

    // 展开态
    $$('#apxMain .apx-item').forEach((el) => {
      const no = el.dataset.no;
      if (state.openIds.has(no)) el.classList.add('open');
      el.querySelector('.apx-item-head').addEventListener('click', (e) => {
        if (e.target.closest('.xref')) return;
        el.classList.toggle('open');
        if (el.classList.contains('open')) state.openIds.add(no); else state.openIds.delete(no);
      });
    });

    bindXrefs($('#apxMain'));
  }

  function renderTerm(it) {
    return `
      <article class="apx-item" id="${esc(domId(it.no))}" data-no="${esc(it.no)}">
        <div class="apx-item-head">
          <span class="apx-no">${esc(it.no)}</span>
          <span class="apx-term">${esc(it.term)}</span>
          ${it.en ? `<span class="apx-en">${esc(it.en)}</span>` : ''}
          <span class="apx-toggle">▾</span>
        </div>
        <div class="apx-body">
          <div class="apx-field"><span class="apx-fk">含义</span><div class="apx-fv">${esc(it.meaning)}</div></div>
          ${it.scene ? `<div class="apx-field"><span class="apx-fk">适用场景</span><div class="apx-fv">${esc(it.scene)}</div></div>` : ''}
          <div class="apx-links">
            ${(it.related || []).length ? `<span class="apx-lk">相关术语：${it.related.map((r) => xref(r, state.index)).join(' ')}</span>` : ''}
            ${(it.refs || []).length ? `<span class="apx-lk">关联评分：${it.refs.map((r) => xref(r, state.index)).join(' ')}</span>` : ''}
          </div>
        </div>
      </article>`;
  }

  function renderScore(it) {
    return `
      <article class="apx-item apx-item-score" id="${esc(domId(it.no))}" data-no="${esc(it.no)}">
        <div class="apx-item-head">
          <span class="apx-no">${esc(it.no)}</span>
          <span class="apx-term">${esc(it.name)}</span>
          ${it.range ? `<span class="apx-range">${esc(it.range)}</span>` : ''}
          <span class="apx-toggle">▾</span>
        </div>
        <div class="apx-body">
          <div class="apx-field"><span class="apx-fk">评分标准</span>
            <div class="apx-fv"><ul class="apx-std">${(it.standard || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
          </div>
          <div class="apx-field"><span class="apx-fk">判断逻辑</span><div class="apx-fv">${esc(it.logic)}</div></div>
          <div class="apx-field"><span class="apx-fk">数据来源</span><div class="apx-fv">${esc(it.source)}</div></div>
          ${it.where ? `<div class="apx-field"><span class="apx-fk">出现位置</span><div class="apx-fv">${esc(it.where)}</div></div>` : ''}
          <div class="apx-links">
            ${(it.related || []).length ? `<span class="apx-lk">依赖术语：${it.related.map((r) => xref(r, state.index)).join(' ')}</span>` : ''}
          </div>
        </div>
      </article>`;
  }

  // ============================================================
  // 交互
  // ============================================================
  function bindXrefs(root) {
    if (!root) return;
    $$('.xref', root).forEach((a) => {
      if (a.dataset.bound) return;
      a.dataset.bound = '1';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        jumpTo(domId(a.dataset.ref));
      });
    });
  }

  function jumpTo(id) {
    const el = document.getElementById(id);
    if (!el) { toast('未找到该条目', 'err'); return; }
    // 展开目标条目
    if (el.classList.contains('apx-item') && !el.classList.contains('open')) {
      el.classList.add('open');
      state.openIds.add(el.dataset.no);
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('apx-flash');
    setTimeout(() => el.classList.remove('apx-flash'), 1600);
  }

  function setAllOpen(open) {
    state.openIds = new Set();
    if (open) $$('#apxMain .apx-item').forEach((el) => state.openIds.add(el.dataset.no));
    $$('#apxMain .apx-item').forEach((el) => el.classList.toggle('open', open));
  }

  function bindOnce() {
    const inp = $('#apxSearch');
    if (inp && !inp.dataset.bound) {
      inp.dataset.bound = '1';
      let t = null;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { state.keyword = inp.value.trim(); drawMain(); }, 200);
      });
    }
    const ex = $('#apxExpandAll');
    if (ex && !ex.dataset.bound) { ex.dataset.bound = '1'; ex.addEventListener('click', () => setAllOpen(true)); }
    const co = $('#apxCollapseAll');
    if (co && !co.dataset.bound) { co.dataset.bound = '1'; co.addEventListener('click', () => setAllOpen(false)); }
  }

  function init() {
    // 支持 #appendix?no=A.3.5 深链直达某条目
  }

  window.ViewAppendix = { render, init, jumpTo };
})();
