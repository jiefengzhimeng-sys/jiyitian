/**
 * daily_aggs DAO —— 读性能的关键表
 *
 * 设计要点（技术文档 4.3 / 5.6）：
 *   _id = {userId}_{YYYY-MM-DD}，一天一条。写入用 inc 原子自增，
 *   不做「先查再算再写」，避免并发丢更新。
 *   读统计只点查 7~31 条聚合记录，绝不实时扫 records 全表。
 *
 * 允许最终一致：计数漂移由 reconcile 脚本每日校准（技术文档 4.5）。
 */

const { db, _, COL } = require('../core/db');
const { getById, inc } = require('./base');

// 情绪分数映射（1-6），用于算当日心情均分，曲线要的是趋势而不是绝对值
const MOOD_SCORE = { low: 1, tired: 2, anx: 3, angry: 4, calm: 5, joy: 6 };

const aggId = (userId, date) => `${userId}_${date}`;

/**
 * 记录创建后的增量更新
 * 用 upsert 语义：文档不存在时 add 一条初始值，存在则 inc
 */
async function bumpOnCreate(userId, record) {
  const id = aggId(userId, record.recordDate);
  const tag = record.tag || 'other';
  const mediaCount = (record.mediaSnap || []).length;
  const isVoice = record.typeHint === 'voice' || record.tag === 'voice';

  const incFields = { recordCount: 1 };
  incFields[`byTag.${tag}`] = 1;
  if (isVoice) incFields.voiceCount = 1;
  if (mediaCount) incFields.mediaCount = mediaCount;
  if (record.mood) {
    incFields[`moodCounts.${record.mood}`] = 1;
    incFields.moodScoreSum = MOOD_SCORE[record.mood] || 3;
    incFields.moodScoreCount = 1;
  }

  const setFields = { updatedAt: Date.now() };
  if (mediaCount) setFields.hasMedia = true;
  // 体重取当日最后一次（同一天多次称重以最新为准，否则曲线会打结）
  const w = record.detail && record.detail.weight;
  if (typeof w === 'number' && w > 0) setFields.weight = w;

  const data = Object.assign(inc(incFields), setFields);

  try {
    await db.collection(COL.daily).doc(id).update({ data });
  } catch (e) {
    // 文档不存在 → 建初始值
    const base = {
      _id: id,
      userId,
      date: record.recordDate,
      recordCount: 1,
      byTag: { [tag]: 1 },
      moodCounts: record.mood ? { [record.mood]: 1 } : {},
      moodScoreSum: record.mood ? MOOD_SCORE[record.mood] || 3 : 0,
      moodScoreCount: record.mood ? 1 : 0,
      voiceCount: isVoice ? 1 : 0,
      mediaCount,
      hasMedia: mediaCount > 0,
      updatedAt: Date.now()
    };
    if (typeof w === 'number' && w > 0) base.weight = w;
    try {
      await db.collection(COL.daily).add({ data: base });
    } catch (e2) {
      // 并发插入冲突：退回 update
      try {
        await db.collection(COL.daily).doc(id).update({ data });
      } catch (e3) {
        console.warn('[daily] 增量更新失败', e3 && e3.message);
      }
    }
  }
}

/** 记录删除后的增量回减（允许瞬时负数，对账修正） */
async function bumpOnDelete(userId, record) {
  const id = aggId(userId, record.recordDate);
  const tag = record.tag || 'other';
  const mediaCount = (record.mediaSnap || []).length;
  const isVoice = record.typeHint === 'voice' || record.tag === 'voice';

  const incFields = { recordCount: -1 };
  incFields[`byTag.${tag}`] = -1;
  if (isVoice) incFields.voiceCount = -1;
  if (mediaCount) incFields.mediaCount = -mediaCount;
  if (record.mood) {
    incFields[`moodCounts.${record.mood}`] = -1;
    incFields.moodScoreSum = -(MOOD_SCORE[record.mood] || 3);
    incFields.moodScoreCount = -1;
  }

  try {
    await db.collection(COL.daily).doc(id).update({
      data: Object.assign(inc(incFields), { updatedAt: Date.now() })
    });
  } catch (e) {
    // 聚合记录不存在说明本来就没算过，不用管
  }
}

/** 区间查询：统计页与图表都走这里，条数 ≤ 90 */
async function getRange(userId, startDate, endDate) {
  const res = await db
    .collection(COL.daily)
    .where({ userId, date: _.gte(startDate).and(_.lte(endDate)) })
    .orderBy('date', 'asc')
    .limit(120)
    .get();
  return res.data || [];
}

async function getByDate(userId, date) {
  return getById(COL.daily, aggId(userId, date));
}

/** 有记录的日子（streak 计算用）：只取近 N 天，避免全表 */
async function listActiveDates(userId, since, limit) {
  const res = await db
    .collection(COL.daily)
    .where({ userId, date: _.gte(since), recordCount: _.gt(0) })
    .field({ date: true })
    .orderBy('date', 'desc')
    .limit(limit || 200)
    .get();
  return (res.data || []).map(d => d.date);
}

/** 某月有记录的日子（打卡月历用） */
async function listMonthDates(userId, monthKey) {
  const start = `${monthKey}-01`;
  const end = `${monthKey}-31`; // 字符串比较，31 号不存在也不会误命中
  const res = await db
    .collection(COL.daily)
    .where({ userId, date: _.gte(start).and(_.lte(end)), recordCount: _.gt(0) })
    .field({ date: true })
    .orderBy('date', 'asc')
    .limit(31)
    .get();
  return (res.data || []).map(d => d.date);
}

/**
 * 按源数据重算某天聚合（对账修复用）
 * 与增量更新是两套实现，故意不复用：一增一全量，能互相校验
 */
async function rebuildDay(userId, date, records) {
  const byTag = {};
  const moodCounts = {};
  let moodScoreSum = 0;
  let moodScoreCount = 0;
  let mediaCount = 0;
  let voiceCount = 0;
  let weight;

  records.forEach(r => {
    const tag = r.tag || 'other';
    byTag[tag] = (byTag[tag] || 0) + 1;
    if (r.mood) {
      moodCounts[r.mood] = (moodCounts[r.mood] || 0) + 1;
      moodScoreSum += MOOD_SCORE[r.mood] || 3;
      moodScoreCount++;
    }
    const mc = (r.mediaSnap || []).length;
    mediaCount += mc;
    if (r.typeHint === 'voice') voiceCount++;
    const w = r.detail && r.detail.weight;
    if (typeof w === 'number' && w > 0) {
      if (weight === undefined || r.createdAt >= (r._createdAt || 0)) weight = w;
    }
  });

  const doc = {
    _id: aggId(userId, date),
    userId,
    date,
    recordCount: records.length,
    byTag,
    moodCounts,
    moodScoreSum,
    moodScoreCount,
    mediaCount,
    hasMedia: mediaCount > 0,
    voiceCount,
    updatedAt: Date.now()
  };
  if (weight !== undefined) doc.weight = weight;

  try {
    await db.collection(COL.daily).doc(doc._id).set({ data: doc });
  } catch (e) {
    await db.collection(COL.daily).add({ data: doc });
  }
  return doc;
}

module.exports = {
  MOOD_SCORE,
  aggId,
  bumpOnCreate,
  bumpOnDelete,
  getRange,
  getByDate,
  listActiveDates,
  listMonthDates,
  rebuildDay
};
