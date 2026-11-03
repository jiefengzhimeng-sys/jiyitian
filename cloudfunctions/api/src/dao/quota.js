/**
 * ai_quota DAO —— 频控与成本账本
 *
 * 设计要点：
 *   _id = {userId}_{YYYY-MM-DD}_{periodType}，一天一条一类。
 *   三个配额同时管：
 *     ① 每周期正式生成次数（1 次）
 *     ② 手动重试额度（2 次，PRD R10-07 要求失败可重试且不额外消耗正式次数）
 *     ③ 单用户单日总调用（10 次，兜住异常刷接口）
 *   另记 tokens / costCents，供全局日预算与成本报表使用。
 */

const { db, _, COL } = require('../core/db');
const { quotaId } = require('../core/ids');
const { getById, inc } = require('./base');

const DEFAULT = {
  count: 0, // 正式生成次数
  retryCount: 0, // 重试次数
  callCount: 0, // 实际调用 LLM 次数（含重试）
  promptTokens: 0,
  completionTokens: 0,
  costCents: 0,
  updatedAt: 0
};

async function peek(userId, date, periodType) {
  const doc = await getById(COL.quota, quotaId(userId, date, periodType));
  return Object.assign({}, DEFAULT, doc || {});
}

/**
 * 消耗一次额度
 * @param {object} p {userId, date, periodType, kind: 'official'|'retry', limits}
 * @returns {{allowed:boolean, reason?:string, quota:object}}
 */
async function consume(p) {
  const id = quotaId(p.userId, p.date, p.periodType);
  const cur = await peek(p.userId, p.date, p.periodType);
  const limits = p.limits || { perPeriod: 1, retryAllowance: 2, perUserPerDay: 10 };

  if (cur.callCount >= limits.perUserPerDay) {
    return { allowed: false, reason: 'daily_call_limit', quota: cur };
  }
  if (p.kind === 'official' && cur.count >= limits.perPeriod) {
    // 正式次数用完后仍可用重试额度（用户失败重试场景）
    if (cur.retryCount >= limits.retryAllowance) {
      return { allowed: false, reason: 'period_limit', quota: cur };
    }
  }
  if (p.kind === 'retry' && cur.retryCount >= limits.retryAllowance) {
    return { allowed: false, reason: 'retry_limit', quota: cur };
  }

  const bump = { callCount: 1, updatedAt: Date.now() };
  if (p.kind === 'official') bump.count = 1;
  else bump.retryCount = 1;

  try {
    await db
      .collection(COL.quota)
      .doc(id)
      .update({ data: inc(bump) });
  } catch (e) {
    try {
      await db
        .collection(COL.quota)
        .add({ data: Object.assign({ _id: id, userId: p.userId, date: p.date, periodType: p.periodType }, DEFAULT, { count: p.kind === 'official' ? 1 : 0, retryCount: p.kind === 'retry' ? 1 : 0, callCount: 1, updatedAt: Date.now() }) });
    } catch (e2) {
      // 并发下可能刚被建好，再 update 一次
      await db.collection(COL.quota).doc(id).update({ data: inc(bump) }).catch(() => {});
    }
  }

  return { allowed: true, quota: await peek(p.userId, p.date, p.periodType) };
}

/** 记账：tokens 与成本（调用成功或失败都记，失败也烧 token） */
async function recordUsage(userId, date, periodType, usage) {
  const id = quotaId(userId, date, periodType);
  const bump = {
    promptTokens: Math.round(usage.promptTokens || 0),
    completionTokens: Math.round(usage.completionTokens || 0),
    costCents: Math.max(0, Math.round((usage.costCents || 0) * 100) / 100),
    updatedAt: Date.now()
  };
  await db.collection(COL.quota).doc(id).update({ data: inc(bump) }).catch(() => {});
}

/** 全局当日花费（分），用于日预算熔断。只扫当天，量可控 */
async function dayCostCents(date) {
  const res = await db
    .collection(COL.quota)
    .where({ date, costCents: _.gt(0) })
    .field({ costCents: true })
    .limit(1000)
    .get();
  return (res.data || []).reduce((s, r) => s + (r.costCents || 0), 0);
}

/** 清理 3 个月前的配额记录（技术文档 4.8） */
async function cleanup(beforeDate, batch) {
  const res = await db
    .collection(COL.quota)
    .where({ date: _.lt(beforeDate) })
    .limit(batch || 100)
    .get();
  const rows = res.data || [];
  for (const r of rows) {
    await db.collection(COL.quota).doc(r._id).remove().catch(() => {});
  }
  return rows.length;
}

module.exports = { DEFAULT, peek, consume, recordUsage, dayCostCents, cleanup };
