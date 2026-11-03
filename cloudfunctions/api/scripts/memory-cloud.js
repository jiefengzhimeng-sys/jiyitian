/**
 * 内存版 wx-server-sdk（仅供本地测试）
 *
 * 目的：让云函数代码在本地 Node 里原样跑起来，不需要云环境、不需要网络。
 * 覆盖业务真正用到的子集：where / orderBy / limit / skip / field / count /
 * doc().get/update/set/remove / add / command 全套操作符。
 *
 * 行为刻意贴近云开发的几个「坑」：
 *   ① add 时 _id 重复会抛错（业务代码依赖这个来走 update 降级）
 *   ② update / set 不存在的文档会抛错（业务代码的 try/catch 才能被触发）
 *   ③ doc().get() 不存在时抛错而不是返回空
 * 如果本地模拟得太宽容，线上那些降级分支就永远测不到。
 */
const Module = require('module');

/* ---------------- 条件操作符 ---------------- */
const CMD = '__wk_cmd';

const cmd = (op, value) => ({
  [CMD]: op,
  value,
  // 支持 _.gte(x).and(_.lte(y)) 链式组合
  and(other) {
    return { [CMD]: 'and', conds: [this, other] };
  },
  or(other) {
    return { [CMD]: 'or', conds: [this, other] };
  }
});

const command = {
  eq: v => cmd('eq', v),
  neq: v => cmd('neq', v),
  gt: v => cmd('gt', v),
  gte: v => cmd('gte', v),
  lt: v => cmd('lt', v),
  lte: v => cmd('lte', v),
  in: v => cmd('in', v),
  nin: v => cmd('nin', v),
  exists: v => cmd('exists', v),
  inc: v => ({ [CMD]: 'inc', value: v }),
  push: v => ({ [CMD]: 'push', value: v }),
  pull: v => ({ [CMD]: 'pull', value: v }),
  and: arr => ({ [CMD]: 'and', conds: arr }),
  or: arr => ({ [CMD]: 'or', conds: arr }),
  aggregate: {
    sum: v => ({ [CMD]: 'agg_sum', value: v })
  }
};

/* ---------------- 工具 ---------------- */
const isCmd = v => v && typeof v === 'object' && v[CMD];

/** 取嵌套字段，支持 'detail.weight' */
function getPath(obj, path) {
  if (path.indexOf('.') < 0) return obj ? obj[path] : undefined;
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

/** 设嵌套字段，支持 'byTag.sport' */
function setPath(obj, path, value) {
  if (path.indexOf('.') < 0) {
    obj[path] = value;
    return;
  }
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 单个字段值是否匹配条件 */
function matchValue(actual, expect) {
  // 正则（db.RegExp）直接测试字符串
  if (expect instanceof RegExp) return expect.test(String(actual === undefined ? '' : actual));
  if (!isCmd(expect)) {
    // 普通值：null 视为「不存在或为 null」
    if (expect === null) return actual === null || actual === undefined;
    return deepEqual(actual, expect);
  }

  const { [CMD]: op, value, conds } = expect;
  switch (op) {
    case 'eq':
      return deepEqual(actual, value);
    case 'neq':
      return !deepEqual(actual, value);
    case 'gt':
      return actual !== undefined && actual !== null && actual > value;
    case 'gte':
      return actual !== undefined && actual !== null && actual >= value;
    case 'lt':
      return actual !== undefined && actual !== null && actual < value;
    case 'lte':
      return actual !== undefined && actual !== null && actual <= value;
    case 'in':
      return (value || []).some(v => deepEqual(actual, v));
    case 'nin':
      return !(value || []).some(v => deepEqual(actual, v));
    case 'exists':
      return value ? actual !== undefined : actual === undefined;
    case 'and':
      return (conds || []).every(c => matchValue(actual, c));
    case 'or':
      return (conds || []).some(c => matchValue(actual, c));
    default:
      return false;
  }
}

/** 整条文档是否匹配 where */
function matchDoc(doc, where) {
  if (!where) return true;
  if (isCmd(where)) {
    const { [CMD]: op, conds } = where;
    if (op === 'and') return (conds || []).every(c => matchDoc(doc, c));
    if (op === 'or') return (conds || []).some(c => matchDoc(doc, c));
    return false;
  }
  return Object.keys(where).every(k => {
    const expect = where[k];
    if (expect === undefined) return true;
    return matchValue(getPath(doc, k), expect);
  });
}

let autoId = 0;
const genId = () => 'id_' + (++autoId).toString(36) + '_' + Math.random().toString(36).slice(2, 8);

/* ---------------- 数据层 ---------------- */
class MemoryDB {
  constructor() {
    this.store = {}; // {colName: Map<id, doc>}
  }

  collection(name) {
    if (!this.store[name]) this.store[name] = new Map();
    return new Query(this.store[name], name, this);
  }
}

class Query {
  constructor(map, name, db) {
    this.map = map;
    this.name = name;
    this.db = db;
    this._where = null;
    this._orders = [];
    this._limit = 100;
    this._skip = 0;
  }

  where(cond) {
    this._where = cond;
    return this;
  }

  orderBy(key, order) {
    this._orders.push({ key, order: order || 'asc' });
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  skip(n) {
    this._skip = n;
    return this;
  }

  field() {
    // 投影对业务只是省带宽，测试里不实现，返回全字段
    return this;
  }

  _rows() {
    let rows = Array.from(this.map.values()).filter(d => matchDoc(d, this._where));
    if (this._orders.length) {
      rows.sort((a, b) => {
        for (const o of this._orders) {
          const av = getPath(a, o.key);
          const bv = getPath(b, o.key);
          if (av === bv) continue;
          if (av === undefined || av === null) return 1;
          if (bv === undefined || bv === null) return -1;
          const r = av < bv ? -1 : 1;
          return o.order === 'desc' ? -r : r;
        }
        return 0;
      });
    }
    return rows;
  }

  async get() {
    const rows = this._rows().slice(this._skip, this._skip + this._limit);
    // 深拷贝：防止业务代码意外改到「库」里的对象
    return { data: JSON.parse(JSON.stringify(rows)) };
  }

  async count() {
    return { total: this._rows().length };
  }

  async update({ data }) {
    const rows = this._rows();
    rows.forEach(r => applyUpdate(this.map.get(r._id), data));
    return { stats: { updated: rows.length } };
  }

  async remove() {
    const rows = this._rows();
    rows.forEach(r => this.map.delete(r._id));
    return { stats: { removed: rows.length } };
  }

  async add({ data }) {
    const doc = JSON.parse(JSON.stringify(data));
    if (!doc._id) doc._id = genId();
    if (this.map.has(doc._id)) {
      // 与云开发一致：主键冲突要抛错，业务代码靠它走 update 降级
      const e = new Error('document with _id ' + doc._id + ' already exists');
      e.errCode = -502001;
      throw e;
    }
    this.map.set(doc._id, doc);
    return { _id: doc._id };
  }

  doc(id) {
    const map = this.map;
    return {
      async get() {
        if (!map.has(id)) {
          const e = new Error('document does not exist');
          e.errCode = -501004;
          throw e;
        }
        return { data: JSON.parse(JSON.stringify(map.get(id))) };
      },
      async update({ data }) {
        if (!map.has(id)) {
          const e = new Error('document does not exist');
          e.errCode = -501004;
          throw e;
        }
        applyUpdate(map.get(id), data);
        return { stats: { updated: 1 } };
      },
      async set({ data }) {
        const doc = JSON.parse(JSON.stringify(data));
        doc._id = id;
        map.set(id, doc);
        return { stats: { updated: 1 } };
      },
      async remove() {
        map.delete(id);
        return { stats: { removed: 1 } };
      }
    };
  }
}

/** 应用 update data：inc 自增，其他字段直接写（支持点号路径） */
function applyUpdate(doc, data) {
  Object.keys(data).forEach(k => {
    const v = data[k];
    if (isCmd(v)) {
      const op = v[CMD];
      const cur = getPath(doc, k);
      if (op === 'inc') setPath(doc, k, (typeof cur === 'number' ? cur : 0) + v.value);
      else if (op === 'push') {
        const arr = Array.isArray(cur) ? cur.slice() : [];
        arr.push(v.value);
        setPath(doc, k, arr);
      } else if (op === 'pull') {
        const arr = Array.isArray(cur) ? cur.filter(x => !deepEqual(x, v.value)) : [];
        setPath(doc, k, arr);
      }
    } else {
      setPath(doc, k, v);
    }
  });
}

/* ---------------- 假 cloud 对象 ---------------- */
function createFakeCloud(options) {
  const opt = options || {};
  const db = new MemoryDB();

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      db.command = command;
      db.RegExp = function (o) {
        return new RegExp(o.regexp || o, o.options || '');
      };
      db.serverDate = () => new Date();
      return db;
    },
    getWXContext() {
      return { OPENID: cloud.__openid || '', APPID: 'test-appid', UNIONID: '' };
    },
    async callFunction({ name, data }) {
      if (opt.callFunction) return opt.callFunction({ name, data });
      throw new Error('callFunction 未实现');
    },
    __setOpenid(id) {
      cloud.__openid = id;
    },
    __db: db,
    __dump(col) {
      return Array.from((db.store[col] || new Map()).values());
    },
    __reset() {
      Object.keys(db.store).forEach(k => db.store[k].clear());
    }
  };
  return cloud;
}

/** 把 wx-server-sdk 的 require 劫持到内存实现 */
function install(cloud) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return orig.apply(this, arguments);
  };
  return () => {
    Module._load = orig;
  };
}

module.exports = { createFakeCloud, install, command, matchDoc };
