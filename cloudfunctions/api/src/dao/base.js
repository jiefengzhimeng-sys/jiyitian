/**
 * DAO 公共操作
 * 云开发的 update 在文档不存在时会报错，upsert 需要 try/catch 两步，
 * 这个坑每个集合都会踩，抽出来统一处理。
 */

const { db, _ } = require('../core/db');

/** 文档不存在时的错误特征（不同版本文案不同，用关键字匹配） */
function isNotExist(e) {
  const msg = (e && (e.errMsg || e.message)) || '';
  return /not exist|does not exist|DOCUMENT_NOT_FOUND|-501004|cannot find document/i.test(msg);
}

/** 取单文档，不存在返回 null（不抛错，调用方自己判断） */
async function getById(col, id) {
  if (!id) return null;
  try {
    const res = await db.collection(col).doc(id).get();
    return res && res.data ? res.data : null;
  } catch (e) {
    if (isNotExist(e)) return null;
    throw e;
  }
}

/** 存在则合并更新，不存在则创建。竞态下 add 可能失败，忽略即可（对方已建好） */
async function upsert(col, id, data, createExtra) {
  const payload = Object.assign({}, data);
  delete payload._id;
  try {
    await db.collection(col).doc(id).update({ data: payload });
    return { created: false };
  } catch (e) {
    if (!isNotExist(e)) {
      // 网络类错误不能静默，否则数据静默丢失
      throw e;
    }
    try {
      await db
        .collection(col)
        .add({ data: Object.assign({ _id: id }, createExtra || {}, data) });
      return { created: true };
    } catch (e2) {
      // 并发下别人已经插入，转成更新
      try {
        await db.collection(col).doc(id).update({ data: payload });
        return { created: false, raced: true };
      } catch (e3) {
        throw e2;
      }
    }
  }
}

/** 计数：where 条件必传，避免误扫全表 */
async function count(col, where) {
  if (!where || !Object.keys(where).length) {
    throw new Error('count 必须带条件，禁止全表统计');
  }
  const res = await db.collection(col).where(where).count();
  return res.total || 0;
}

/** 分批拉取（云函数单次 get 上限 100 条，超过必须分页） */
async function fetchAll(col, where, opt) {
  const o = opt || {};
  const limit = o.limit || 100;
  const max = o.max || 500;
  const field = o.field;
  const orderBy = o.orderBy;

  let out = [];
  let skip = 0;
  while (out.length < max) {
    let q = db.collection(col).where(where);
    if (field) q = q.field(field);
    if (orderBy) q = q.orderBy(orderBy.key, orderBy.order || 'asc');
    const res = await q.skip(skip).limit(Math.min(limit, max - out.length)).get();
    const batch = res.data || [];
    out = out.concat(batch);
    if (batch.length < limit) break;
    skip += batch.length;
  }
  return out;
}

/** 安全自增：字段不存在时 inc 依然可用（云开发语义为 0+1），无需先读 */
function inc(fields) {
  const out = {};
  Object.keys(fields).forEach(k => {
    out[k] = _.inc(fields[k]);
  });
  return out;
}

module.exports = { isNotExist, getById, upsert, count, fetchAll, inc };
