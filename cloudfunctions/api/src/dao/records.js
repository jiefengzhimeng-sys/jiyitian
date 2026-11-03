/**
 * records 主表 DAO
 *
 * 字段口径对齐技术文档 4.3（存储层用 userId/recordDate/tag/detail/mediaIds/status），
 * 前端契约用的是 openid/dayKey/category/images —— 两者在 domain/record.js 里做映射，
 * DAO 不认识前端字段，这样 DB 结构能长期稳定，前端改版不影响表结构。
 *
 * 索引依赖（见 scripts/indexes.json）：
 *   ① userId + recordDate(desc) + createdAt(desc)  列表/时间线
 *   ② userId + status + recordDate(desc)           已发布过滤
 *   ③ userId + tag + recordDate(desc)              按标签筛选
 *   ④ idempotencyKey(唯一)                          防重复提交
 */

const { db, _, COL, CURRENT_SCHEMA } = require('../core/db');
const { getById, upsert } = require('./base');

const STATUS = { PUBLISHED: 'published', PENDING: 'pending', REJECTED: 'rejected', DELETED: 'deleted' };

/** 写一条记录 */
async function insert(doc) {
  const data = Object.assign({ schemaVer: CURRENT_SCHEMA }, doc);
  delete data._id;
  const res = await db.collection(COL.records).add({ data });
  return Object.assign({ _id: res._id }, data);
}

async function update(id, patch) {
  const data = Object.assign({}, patch, { updatedAt: Date.now() });
  await db.collection(COL.records).doc(id).update({ data });
}

/** 取单条：带归属校验，越权与不存在都返回 null（不泄露存在性） */
async function findOwned(userId, id) {
  const doc = await getById(COL.records, id);
  if (!doc || doc.userId !== userId) return null;
  return doc;
}

/**
 * 软删除：status 与 deletedAt 分离（技术文档 4.1 原则 4）
 * 违规下架是 rejected，用户删除是 deleted，两者生命周期不同
 */
async function softDelete(id) {
  await db
    .collection(COL.records)
    .doc(id)
    .update({
      data: { status: STATUS.DELETED, deletedAt: Date.now(), updatedAt: Date.now() }
    });
}

/** 幂等命中查询：同用户 + 同幂等键 + 未删除 */
async function findByIdempotency(userId, key) {
  if (!key) return null;
  const res = await db
    .collection(COL.records)
    .where({ userId, idempotencyKey: key, status: STATUS.PUBLISHED })
    .field({ _id: true })
    .limit(1)
    .get();
  const hit = (res.data || [])[0];
  return hit ? getById(COL.records, hit._id) : null;
}

/**
 * 列表查询（游标分页）
 * 游标是 (recordDate, createdAt) 复合值，不用 skip：
 *   skip 在数据量大时会越翻越慢，且分页期间新增数据会造成重复/漏项。
 * 复合游标保证「补记的旧日期记录」也能正确归位。
 */
async function list(options) {
  const o = options;
  const limit = o.limit || 20;

  // 条件用数组拼，最后统一 and：混用字段条件与 command.or 时，
  // 直接往同一对象里塞会互相覆盖（recordDate 只能出现一次）
  const conds = [{ userId: o.userId, status: STATUS.PUBLISHED }];

  if (o.date) conds.push({ recordDate: o.date });
  else if (o.startDate && o.endDate) {
    conds.push({ recordDate: _.gte(o.startDate).and(_.lte(o.endDate)) });
  } else if (o.startDate) conds.push({ recordDate: _.gte(o.startDate) });
  else if (o.endDate) conds.push({ recordDate: _.lte(o.endDate) });

  if (o.tag) conds.push({ tag: o.tag });

  // 复合游标：先比日期，日期相同再比创建时间。
  // 用 or 而不是单个 createdAt，是因为补记会产生「旧日期 / 新创建时间」的记录，
  // 单按 createdAt 翻页会把这些记录排到错误位置，出现重复或漏项。
  if (o.cursor && o.cursor.date && o.cursor.createdAt) {
    conds.push(
      _.or([
        { recordDate: _.lt(o.cursor.date) },
        { recordDate: o.cursor.date, createdAt: _.lt(o.cursor.createdAt) }
      ])
    );
  }

  const where = conds.length === 1 ? conds[0] : _.and(conds);

  const res = await db
    .collection(COL.records)
    .where(where)
    .orderBy('recordDate', 'desc')
    .orderBy('createdAt', 'desc')
    .limit(limit + 1)
    .get();
  return shapePage(res.data || [], limit);
}

/** 多取一条判断 hasMore，避免额外 count 查询 */
function shapePage(rows, limit) {
  const hasMore = rows.length > limit;
  const list = hasMore ? rows.slice(0, limit) : rows;
  const last = list[list.length - 1];
  return {
    list,
    hasMore,
    nextCursor: last ? { date: last.recordDate, createdAt: last.createdAt } : null
  };
}

/** 某天全部记录（首页今日流） */
async function listByDate(userId, date, limit) {
  const res = await db
    .collection(COL.records)
    .where({ userId, recordDate: date, status: STATUS.PUBLISHED })
    .orderBy('createdAt', 'desc')
    .limit(limit || 50)
    .get();
  return res.data || [];
}

/** 区间内用于统计的瘦身字段（不带 content，省带宽） */
async function listForStats(userId, startDate, endDate) {
  const res = await db
    .collection(COL.records)
    .where({
      userId,
      status: STATUS.PUBLISHED,
      recordDate: _.gte(startDate).and(_.lte(endDate))
    })
    .field({ recordDate: true, tag: true, mood: true, detail: true, mediaIds: true, createdAt: true })
    .orderBy('createdAt', 'asc')
    .limit(300)
    .get();
  return res.data || [];
}

/** 区间内用于 AI 总结的记录（含正文，但要裁剪） */
async function listForSummary(userId, startDate, endDate, limit) {
  const res = await db
    .collection(COL.records)
    .where({
      userId,
      status: STATUS.PUBLISHED,
      recordDate: _.gte(startDate).and(_.lte(endDate))
    })
    .field({ recordDate: true, tag: true, mood: true, detail: true, content: true, createdAt: true })
    .orderBy('createdAt', 'asc')
    .limit(limit || 300)
    .get();
  return res.data || [];
}

/** 体重序列：只取有 detail.weight 的记录，避免拉全量 */
async function listWeights(userId, startDate, endDate) {
  const res = await db
    .collection(COL.records)
    .where({
      userId,
      status: STATUS.PUBLISHED,
      recordDate: _.gte(startDate).and(_.lte(endDate)),
      'detail.weight': _.gt(0)
    })
    .field({ recordDate: true, 'detail.weight': true, createdAt: true })
    .orderBy('createdAt', 'asc')
    .limit(200)
    .get();
  return res.data || [];
}

/** 累计条数（用户档案页用；不求精确到秒，允许最终一致） */
async function countPublished(userId) {
  const res = await db
    .collection(COL.records)
    .where({ userId, status: STATUS.PUBLISHED })
    .count();
  return res.total || 0;
}

/** 物理删除（回收站到期清理用），返回被删条数 */
async function hardDeleteOlderThan(cutoff, batch) {
  const res = await db
    .collection(COL.records)
    .where({ status: STATUS.DELETED, deletedAt: _.lt(cutoff) })
    .limit(batch || 100)
    .get();
  const rows = res.data || [];
  let removed = 0;
  for (const r of rows) {
    try {
      await db.collection(COL.records).doc(r._id).remove();
      removed++;
    } catch (e) {
      // 单条失败不影响整批
    }
  }
  return { removed, rows };
}

module.exports = {
  STATUS,
  insert,
  update,
  findOwned,
  softDelete,
  findByIdempotency,
  list,
  listByDate,
  listForStats,
  listForSummary,
  listWeights,
  countPublished,
  hardDeleteOlderThan,
  upsert
};
