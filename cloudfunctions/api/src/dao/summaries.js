/**
 * ai_summaries DAO
 * _id = {userId}_{periodType}_{periodKey} —— 天然去重，
 * 同一周期无论触发多少次都只落一条文档，不会出现「两个周报」。
 *
 * status 状态机（对应技术文档 5.5）：
 *   generating → ready      生成成功
 *   generating → failed     LLM 与规则模板都失败（极少）
 *   generating → insufficient  数据不足（PRD R10-06）
 * 生成中重复点击直接返回 generating，不重复调用 LLM（省钱且防并发）
 */

const { db, COL } = require('../core/db');
const { summaryId } = require('../core/ids');
const { getById } = require('./base');

const STATUS = {
  GENERATING: 'generating',
  READY: 'ready',
  FAILED: 'failed',
  INSUFFICIENT: 'insufficient'
};

async function get(userId, periodType, periodKey) {
  return getById(COL.summaries, summaryId(userId, periodType, periodKey));
}

async function save(userId, periodType, periodKey, patch) {
  const id = summaryId(userId, periodType, periodKey);
  const data = Object.assign({}, patch, {
    _id: id,
    userId,
    periodType,
    periodKey,
    updatedAt: Date.now()
  });
  delete data._id;
  const withId = Object.assign({ _id: id }, data);
  try {
    await db.collection(COL.summaries).doc(id).set({ data: withId });
  } catch (e) {
    await db.collection(COL.summaries).add({ data: withId });
  }
  return withId;
}

/** 标记生成中（先落库再调 LLM，防止并发重复调） */
function markGenerating(userId, periodType, periodKey) {
  return save(userId, periodType, periodKey, {
    status: STATUS.GENERATING,
    startedAt: Date.now()
  });
}

/** 最近 N 条总结（我的页 / 总结页列表） */
async function listRecent(userId, limit) {
  const res = await db
    .collection(COL.summaries)
    .where({ userId, status: STATUS.READY })
    .orderBy('periodKey', 'desc')
    .limit(limit || 12)
    .get();
  return res.data || [];
}

/**
 * 历史总结瘦身（技术文档 4.8）：超过 12 个月只留文本，删掉 chartData。
 * chartData 是最大字段（几十个点），删掉能省 80% 空间。
 */
async function trimOld(userId, beforePeriodKey) {
  const res = await db
    .collection(COL.summaries)
    .where({ userId, periodKey: db.command.lt(beforePeriodKey) })
    .field({ _id: true, chartData: true })
    .limit(100)
    .get();
  const rows = (res.data || []).filter(r => r.chartData);
  for (const r of rows) {
    await db.collection(COL.summaries).doc(r._id).update({ data: { chartData: null, trimmed: true } });
  }
  return rows.length;
}

module.exports = { STATUS, get, save, markGenerating, listRecent, trimOld };
