/**
 * audit_logs DAO —— 审计与风控日志
 * 只记「有决策意义」的动作：敏感操作、AI 风控拦截、配额拒绝、越权尝试。
 * 不记普通读接口，否则日志量比业务数据还大。
 * 保留 6 个月（技术文档 4.8），超期由定时任务清理。
 */

const { db, _, COL } = require('../core/db');

const ACTIONS = {
  RECORD_CREATE: 'record.create',
  RECORD_DELETE: 'record.remove',
  RECORD_DENIED: 'record.denied',
  AI_SUMMARY: 'ai.summary',
  AI_BLOCKED: 'ai.blocked',
  QUOTA_DENIED: 'quota.denied',
  PROFILE_UPDATE: 'profile.update',
  USER_DELETE: 'user.delete',
  ADMIN_TASK: 'admin.task'
};

/**
 * 写审计日志
 * 注意：日志失败绝不能影响主流程，所以全部 catch 掉。
 * 也不做 await 串行等待优化——云函数返回后实例会冻结，未完成的异步会被丢弃，
 * 所以这里老老实实 await，成本是一次 insert（几毫秒）。
 */
async function log(entry) {
  const doc = {
    userId: entry.userId || '',
    action: entry.action,
    target: entry.target || '',
    result: entry.result || 'ok',
    reason: entry.reason || '',
    meta: entry.meta || null,
    at: Date.now()
  };
  try {
    await db.collection(COL.audit).add({ data: doc });
    return true;
  } catch (e) {
    console.warn('[audit] 写入失败', e && e.message);
    return false;
  }
}

/** 清理超期日志 */
async function cleanup(beforeTs, batch) {
  const res = await db
    .collection(COL.audit)
    .where({ at: _.lt(beforeTs) })
    .limit(batch || 100)
    .get();
  const rows = res.data || [];
  for (const r of rows) {
    await db.collection(COL.audit).doc(r._id).remove().catch(() => {});
  }
  return rows.length;
}

module.exports = { ACTIONS, log, cleanup };
