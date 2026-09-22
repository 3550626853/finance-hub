/* api.js — 后端接口封装 */
(function () {
  'use strict';

  const BASE = '';

  async function request(path, { method = 'GET', body = null, timeout = 90000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
      if (!json.ok) throw new Error(json.error || `请求失败 (${res.status})`);
      return json.data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时，数据源响应较慢');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const qs = (obj) => Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  window.API = {
    health: () => request('/api/health'),
    overview: () => request('/api/overview'),

    ipo: (market) => request(`/api/ipo?${qs({ market })}`),
    ipoCalendar: (market, limit) => request(`/api/ipo/calendar?${qs({ market, limit })}`),
    ipoNews: (opt) => request(`/api/ipo/news?${qs(opt || {})}`),
    stockNews: (opt) => request(`/api/ipo/news/stock?${qs(opt || {})}`),
    appendix: () => request('/api/appendix'),

    stockCatalog: () => request('/api/stocks/catalog'),
    stockList: (opt) => request(`/api/stocks/list?${qs(opt || {})}`),

    recommendBoards: () => request('/api/recommend/boards'),
    recommendBoard: (id, limit) => request(`/api/recommend/${encodeURIComponent(id)}?${qs({ limit })}`),

    financeSearch: (q) => request(`/api/finance/search?${qs({ q })}`),
    finance: (code, periods) => request(`/api/finance/${encodeURIComponent(code)}?${qs({ periods })}`),
    financeBusiness: (code) => request(`/api/finance/${encodeURIComponent(code)}/business`),
    financeCompare: (codes, periods) => request(`/api/finance/compare?${qs({ codes: codes.join(','), periods })}`),
    financeCalendar: (market, limit) => request(`/api/finance/calendar?${qs({ market, limit })}`),

    indices: () => request('/api/market/indices'),
    breadth: () => request('/api/market/breadth'),
    profile: () => request('/api/market/profile'),
    sectors: (opt) => request(`/api/market/sectors?${qs(opt || {})}`),
    hot: () => request('/api/market/hot'),
    marketNews: (opt) => request(`/api/market/news?${qs(opt || {})}`),
    refreshNews: () => request('/api/market/news/refresh', { method: 'POST', body: {} }),
    flow: (codes) => request(`/api/market/flow?${qs({ codes: (codes || []).join(',') })}`),
    technical: (codes, limit) => request(`/api/market/technical?${qs({ codes: (codes || []).join(','), limit })}`),
    report: () => request('/api/market/report'),
    exportReport: () => request('/api/market/report/export', { method: 'POST', body: {} }),

    notifications: (filter) => request(`/api/notifications?${qs(filter || {})}`),
    markRead: (ids) => request('/api/notifications/read', { method: 'POST', body: { ids: ids || [] } }),
    clearNotifications: (onlyRead) => request('/api/notifications/clear', { method: 'POST', body: { onlyRead: !!onlyRead } }),
    scanNow: () => request('/api/notifications/scan', { method: 'POST', body: {} }),

    subscriptions: () => request('/api/subscriptions'),
    toggleSubscription: (id, enabled) => request('/api/subscriptions/toggle', { method: 'POST', body: { id, enabled } }),
    updateSubscription: (id, patch) => request('/api/subscriptions/update', { method: 'POST', body: { id, patch } }),

    watchlist: () => request('/api/watchlist'),
    addWatch: (code) => request('/api/watchlist', { method: 'POST', body: { code } }),
    removeWatch: (code) => request('/api/watchlist', { method: 'POST', body: { code, action: 'remove' } }),
    setWatchlist: (list) => request('/api/watchlist', { method: 'POST', body: { list } }),

    // ---- AI 选股指南（按激进度档案）----
    pickerProfiles: () => request('/api/picker/profiles'),
    pickerDaily: (profile) => request(`/api/picker/daily?${qs({ profile })}`),
    runPicker: (profile) => request('/api/picker/daily/run', { method: 'POST', body: { profile: profile || 'balanced' } }),
    holdingsAnalysis: () => request('/api/picker/holdings'),
    portfolio: () => request('/api/portfolio'),
    saveHolding: (body) => request('/api/portfolio/holdings', { method: 'POST', body }),
    saveTransaction: (body) => request('/api/portfolio/transactions', { method: 'POST', body }),

    // ---- 全球行情（贵金属 / 外汇）----
    metals: () => request('/api/metals'),
    metalTrend: (key, limit) => request(`/api/metals/${encodeURIComponent(key)}/trend?${qs({ limit })}`),
    fx: () => request('/api/fx'),
    fxTrend: (code, limit) => request(`/api/fx/${encodeURIComponent(code)}/trend?${qs({ limit })}`),
    globalIndices: () => request('/api/global/indices'),

    // ---- 国际形势金融分析 ----
    worldDesk: (newsLimit) => request(`/api/world?${qs({ newsLimit })}`),

    state: () => request('/api/state'),
    clearCache: () => request('/api/cache/clear', { method: 'POST', body: {} }),
  };
})();
