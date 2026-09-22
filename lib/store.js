'use strict';
/**
 * store.js — 轻量 JSON 持久化（原子写 + 内存索引）
 * 用于订阅规则、通知记录、快照留存。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_STATE = {
  version: 1,
  subscriptions: [
    { id: 'sub-ipo-all', type: 'ipo', label: '新股发行动态（沪深）', market: 'hs', enabled: true, createdAt: null },
    { id: 'sub-cal-ipo', type: 'ipo_calendar', label: '新股申购/上市提醒', market: 'hs', enabled: true, createdAt: null },
    { id: 'sub-report', type: 'financial_report', label: '财报披露提醒', market: 'hs', enabled: true, createdAt: null },
    { id: 'sub-index', type: 'index_move', label: '指数大幅波动预警（±1%）', threshold: 1, enabled: true, createdAt: null },
    { id: 'sub-watch', type: 'watchlist_move', label: '自选股异动（±5%）', threshold: 5, enabled: true, createdAt: null },
  ],
  watchlist: ['sh600519', 'sz300750', 'sh601318', 'sz000858'],
  /** 持仓：{ code, name, qty, cost, note, createdAt, updatedAt } */
  holdings: [],
  /** 交易记录：{ id, code, name, side, price, qty, time, note, createdAt } */
  transactions: [],
  notifications: [],
  lastScan: null,
  scanCount: 0,
};

class Store {
  constructor(file = 'app-state.json') {
    this.file = path.join(DATA_DIR, file);
    // 持仓与交易记录独立持久化：账本数据比应用状态更关键，
    // 与 app-state 隔离可避免状态覆盖（如进程异常回退默认值）连带清空账本
    this.pfFile = path.join(DATA_DIR, 'portfolio.json');
    this.state = this._load();
    this._loadPortfolio();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        return { ...DEFAULT_STATE, ...raw, subscriptions: raw.subscriptions || DEFAULT_STATE.subscriptions };
      }
    } catch (e) {
      console.warn('[store] 状态文件损坏，已回退默认值:', e.message);
    }
    const s = JSON.parse(JSON.stringify(DEFAULT_STATE));
    s.subscriptions.forEach((x) => { x.createdAt = new Date().toISOString(); });
    return s;
  }

  /** 读持仓账本（独立文件）；旧版本数据曾存在 app-state 中，做一次兼容回填 */
  _loadPortfolio() {
    try {
      if (fs.existsSync(this.pfFile)) {
        const p = JSON.parse(fs.readFileSync(this.pfFile, 'utf8'));
        this.state.holdings = p.holdings || [];
        this.state.transactions = p.transactions || [];
        return;
      }
      // 兼容：首次拆分时把 app-state 里的旧数据迁出
      if (this.state.holdings.length || this.state.transactions.length) this._savePortfolio();
    } catch (e) {
      console.warn('[store] 持仓账本读取失败，保留内存值:', e.message);
    }
  }

  _savePortfolio() {
    const tmp = this.pfFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        savedAt: new Date().toISOString(),
        holdings: this.state.holdings,
        transactions: this.state.transactions,
      }, null, 2), 'utf8');
      fs.renameSync(tmp, this.pfFile);
    } catch (e) {
      console.error('[store] 持仓账本保存失败:', e.message);
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] 保存失败:', e.message);
    }
  }

  // ---- 订阅 ----
  get subscriptions() { return this.state.subscriptions; }
  toggleSubscription(id, enabled) {
    const s = this.state.subscriptions.find((x) => x.id === id);
    if (!s) return null;
    if (enabled === undefined) s.enabled = !s.enabled; else s.enabled = !!enabled;
    this.save();
    return s;
  }
  updateSubscription(id, patch) {
    const s = this.state.subscriptions.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch, { id: s.id });
    this.save();
    return s;
  }
  addSubscription(sub) {
    const s = { id: sub.id || `sub-${Date.now()}`, enabled: true, createdAt: new Date().toISOString(), ...sub };
    this.state.subscriptions.push(s);
    this.save();
    return s;
  }
  removeSubscription(id) {
    const n = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter((x) => x.id !== id);
    this.save();
    return n !== this.state.subscriptions.length;
  }

  // ---- 自选 ----
  get watchlist() { return this.state.watchlist; }
  setWatchlist(list) {
    this.state.watchlist = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
    this.save();
    return this.state.watchlist;
  }
  addWatch(code) { return this.setWatchlist([...this.state.watchlist, code]); }
  removeWatch(code) { return this.setWatchlist(this.state.watchlist.filter((c) => c !== code)); }

  // ---- 持仓（AI 选股指南）----
  get holdings() { return this.state.holdings; }

  /** 新增 / 更新持仓（按 code 唯一）。allowZero=false 时数量为 0 视为清仓并移除 */
  upsertHolding({ code, name, qty, cost, note }) {
    const c = String(code || '').trim();
    if (!c) throw Object.assign(new Error('缺少证券代码'), { code: 'BAD_PARAM' });
    const now = new Date().toISOString();
    let h = this.state.holdings.find((x) => x.code === c);
    if (!h) {
      h = { code: c, name: name || c, qty: 0, cost: 0, note: '', createdAt: now, updatedAt: now };
      this.state.holdings.push(h);
    }
    if (name !== undefined) h.name = name || h.name;
    if (qty !== undefined) h.qty = Math.max(0, Number(qty) || 0);
    if (cost !== undefined) h.cost = Math.max(0, Number(cost) || 0);
    if (note !== undefined) h.note = String(note || '');
    h.updatedAt = now;
    // 数量归零视为清仓，自动移除，避免出现 0 股「僵尸持仓」
    if (h.qty === 0) this.state.holdings = this.state.holdings.filter((x) => x.code !== c);
    this._savePortfolio();
    return h;
  }

  removeHolding(code) {
    const before = this.state.holdings.length;
    this.state.holdings = this.state.holdings.filter((x) => x.code !== code);
    this._savePortfolio();
    return before !== this.state.holdings.length;
  }

  // ---- 交易记录 ----
  get transactions() { return this.state.transactions; }

  addTransaction({ code, name, side, price, qty, time, note }) {
    const c = String(code || '').trim();
    const s = String(side || '').toLowerCase();
    if (!c) throw Object.assign(new Error('缺少证券代码'), { code: 'BAD_PARAM' });
    if (!['buy', 'sell'].includes(s)) throw Object.assign(new Error('买卖方向必须是 buy / sell'), { code: 'BAD_PARAM' });
    const p = Number(price); const q = Number(qty);
    if (!(p > 0)) throw Object.assign(new Error('成交价格必须大于 0'), { code: 'BAD_PARAM' });
    if (!(q > 0)) throw Object.assign(new Error('成交数量必须大于 0'), { code: 'BAD_PARAM' });
    const rec = {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      code: c, name: name || c, side: s,
      price: p, qty: q,
      time: String(time || new Date().toISOString().slice(0, 16)).slice(0, 16),
      note: String(note || ''),
      createdAt: new Date().toISOString(),
    };
    this.state.transactions.unshift(rec);
    if (this.state.transactions.length > 2000) this.state.transactions.length = 2000;
    this._savePortfolio();
    return rec;
  }

  updateTransaction(id, patch) {
    const t = this.state.transactions.find((x) => x.id === id);
    if (!t) return null;
    ['code', 'name', 'side', 'time', 'note'].forEach((k) => { if (patch[k] !== undefined) t[k] = patch[k]; });
    if (patch.price !== undefined) { const v = Number(patch.price); if (!(v > 0)) throw Object.assign(new Error('价格必须大于 0'), { code: 'BAD_PARAM' }); t.price = v; }
    if (patch.qty !== undefined) { const v = Number(patch.qty); if (!(v > 0)) throw Object.assign(new Error('数量必须大于 0'), { code: 'BAD_PARAM' }); t.qty = v; }
    this._savePortfolio();
    return t;
  }

  removeTransaction(id) {
    const before = this.state.transactions.length;
    this.state.transactions = this.state.transactions.filter((x) => x.id !== id);
    this._savePortfolio();
    return before !== this.state.transactions.length;
  }

  // ---- 通知 ----
  get notifications() { return this.state.notifications; }

  /** 去重写入：同一 fingerprint 在 windowMs 内不重复 */
  pushNotifications(items, { windowMs = 12 * 3600 * 1000, cap = 400 } = {}) {
    const fresh = [];
    for (const it of items) {
      const fp = it.fingerprint || `${it.type}|${it.title}`;
      const dup = this.state.notifications.find(
        (n) => (n.fingerprint || `${n.type}|${n.title}`) === fp && Date.now() - new Date(n.createdAt).getTime() < windowMs
      );
      if (dup) continue;
      const rec = {
        id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        createdAt: new Date().toISOString(),
        read: false,
        fingerprint: fp,
        ...it,
      };
      this.state.notifications.unshift(rec);
      fresh.push(rec);
    }
    if (fresh.length) {
      if (this.state.notifications.length > cap) this.state.notifications.length = cap;
      this.save();
    }
    return fresh;
  }

  markRead(ids) {
    const set = new Set([].concat(ids || []));
    let n = 0;
    this.state.notifications.forEach((x) => {
      if (set.has('*') || set.has(x.id)) { if (!x.read) { x.read = true; n++; } }
    });
    this.save();
    return n;
  }

  clearNotifications(onlyRead = false) {
    const before = this.state.notifications.length;
    this.state.notifications = onlyRead ? this.state.notifications.filter((x) => !x.read) : [];
    this.save();
    return before - this.state.notifications.length;
  }

  recordScan() {
    this.state.lastScan = new Date().toISOString();
    this.state.scanCount = (this.state.scanCount || 0) + 1;
    // 扫描计数不必每次落盘，仅在其它写操作时一并保存
  }

  // ---- 通用快照 ----
  saveSnapshot(name, data) {
    const f = path.join(DATA_DIR, `${name}.json`);
    try { fs.writeFileSync(f, JSON.stringify({ savedAt: new Date().toISOString(), data }, null, 2), 'utf8'); return f; } catch (_) { return null; }
  }
  loadSnapshot(name) {
    const f = path.join(DATA_DIR, `${name}.json`);
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (_) { return null; }
  }

  stats() {
    const unread = this.state.notifications.filter((x) => !x.read).length;
    return {
      subscriptions: this.state.subscriptions.length,
      enabledSubscriptions: this.state.subscriptions.filter((x) => x.enabled).length,
      notifications: this.state.notifications.length,
      unread,
      watchlist: this.state.watchlist.length,
      holdings: this.state.holdings.length,
      transactions: this.state.transactions.length,
      lastScan: this.state.lastScan,
      scanCount: this.state.scanCount || 0,
    };
  }
}

module.exports = { Store, DATA_DIR, DEFAULT_STATE };
