/**
 * 内部管理动作（定时任务 / 运维脚本调用）
 *
 * 安全：必须带 INTERNAL_TOKEN，且 token 非空。
 * 这些动作能跨用户操作数据，绝不能暴露给小程序端。
 */

const recordService = require('../services/recordService');
const summaryService = require('../services/summaryService');
const recordsDao = require('../dao/records');
const quotaDao = require('../dao/quota');
const summariesDao = require('../dao/summaries');
const audit = require('../dao/auditLogs');
const statsDao = require('../dao/userStats');
const llm = require('../services/llm');
const dateUtil = require('../core/date');
const config = require('../core/config');
const logger = require('../core/logger');
const { bad } = require('../core/errors');

/** 内部动作：入参里必须显式指定 userId（定时任务逐个用户调用） */
const adminActions = {
  /** 重算某用户近 N 天的聚合与 streak */
  'admin.reconcileUser': async p => {
    if (!p.userId) throw bad('缺少 userId');
    return recordService.reconcileUser(p.userId, p.days || 7);
  },

  /** 为某用户预生成指定周期总结（定时任务在周期结束时调用） */
  'admin.genSummary': async p => {
    if (!p.userId) throw bad('缺少 userId');
    return summaryService.preGenerate(p.userId, p.type || 'day');
  },

  /** 物理清理回收站到期记录 */
  'admin.purgeTrash': async p => {
    // 注意不能用 || ：retainDays=0 表示「立即清理」，是合法入参，用 || 会被替换成默认 30
    const retainDays = p.retainDays === undefined ? config.biz.trashRetainDays : p.retainDays;
    const cutoff = Date.now() - retainDays * 86400000;
    const r = await recordsDao.hardDeleteOlderThan(cutoff, p.batch || 100);
    return { removed: r.removed, retainDays, cutoff };
  },

  /** 清理过期配额与审计日志 */
  'admin.cleanup': async p => {
    const today = dateUtil.todayKey();
    const quotaBefore = dateUtil.shiftDay(today, -(p.quotaDays || 90));
    const auditBefore = p.auditDays || 180;
    const quotaRemoved = await quotaDao.cleanup(quotaBefore, p.batch || 100);
    const auditRemoved = await audit.cleanup(Date.now() - auditBefore * 86400000, p.batch || 100);
    return { quotaRemoved, auditRemoved };
  },

  /** 历史总结瘦身：超过 12 个月删 chartData */
  'admin.trimSummaries': async p => {
    if (!p.userId) throw bad('缺少 userId');
    const before = dateUtil.shiftDay(dateUtil.todayKey(), -(p.months || 12) * 30);
    const n = await summariesDao.trimOld(p.userId, before);
    return { trimmed: n };
  },

  /** LLM 配置与连通性自检（部署后第一件事就跑它） */
  'admin.llmInspect': async p => {
    const info = llm.inspect();
    if (p.probe) {
      // probe=true 时真打一次模型，验证 key、网络、返回结构
      const r = await llm.generate({
        periodType: 'day',
        periodLabel: '自检',
        stats: {
          startDay: dateUtil.todayKey(),
          endDay: dateUtil.todayKey(),
          days: 1,
          totalRecords: 5,
          sportCount: 1,
          sportDays: 1,
          dietCount: 2,
          voiceCount: 0,
          imageCount: 1,
          weightCurrent: 62.5,
          weightDelta: -0.3,
          weightSeries: [],
          moodDist: [{ key: 'calm', name: '平静', count: 3, percent: 60 }],
          moodTotal: 5,
          countByDay: [{ dayKey: dateUtil.todayKey(), count: 5 }]
        },
        records: []
      });
      info.probe = { ok: r.ok, meta: r.meta };
    }
    return info;
  },

  /** 批量重算 streak（数据修复用，按 userId 列表） */
  'admin.batchStreak': async p => {
    const ids = p.userIds || [];
    const out = [];
    for (const id of ids) {
      try {
        const s = await statsDao.recomputeStreak(id);
        out.push({ userId: id, streak: s.streakCurrent });
      } catch (e) {
        out.push({ userId: id, error: e.message });
      }
    }
    return { count: out.length, result: out };
  },

  /**
   * 存储体检：部署后与上线前跑一次
   * 微信云开发不支持用 SDK 建索引，索引必须在控制台按 scripts/indexes.json 手工配，
   * 所以这里只能校验「数据本身是否健康」，索引命中情况要看控制台的慢查询。
   */
  'admin.dbCheck': async p => {
    const { db, COL } = require('../core/db');
    const counts = {};
    for (const name of Object.keys(COL)) {
      try {
        const r = await db.collection(COL[name]).count();
        counts[COL[name]] = r.total || 0;
      } catch (e) {
        counts[COL[name]] = 'collection_not_exist';
      }
    }

    // 抽样检查脏数据：老结构文档没有 status/recordDate 会让查询直接漏数据
    const dirty = { noStatus: 0, noDate: 0, noSchemaVer: 0, sampled: 0 };
    try {
      const r = await db
        .collection(COL.records)
        .field({ status: true, recordDate: true, schemaVer: true })
        .limit(p.sample || 100)
        .get();
      const rows = r.data || [];
      dirty.sampled = rows.length;
      rows.forEach(x => {
        if (!x.status) dirty.noStatus++;
        if (!x.recordDate) dirty.noDate++;
        if (!x.schemaVer) dirty.noSchemaVer++;
      });
    } catch (e) {
      dirty.error = e.message;
    }

    return { collections: counts, dirty };
  }
};

/** token 校验：生产环境 token 必须配置，dev 允许空 token 但会打警告 */
function verify(token) {
  const expect = config.internalToken;
  if (!expect) {
    if (config.appEnv === 'prod') {
      logger.error('生产环境未配置 INTERNAL_TOKEN，内部动作已拒绝');
      return false;
    }
    logger.warn('开发环境未配置 INTERNAL_TOKEN，内部动作放行（仅限本地调试）');
    return true;
  }
  return token === expect;
}

module.exports = { adminActions, verify };
