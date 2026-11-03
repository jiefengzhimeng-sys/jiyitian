/**
 * 记录业务逻辑
 *
 * 写入路径（技术文档 5.5）：
 *   幂等检查 → 入参校验归一化 → 落库 → 媒体登记 → 日聚合增量 → streak 重算 → 累计值
 * 每一步失败的处理原则：
 *   - 落库失败：直接报错，用户重试（不能假装成功）
 *   - 聚合/统计失败：记录已存在，降级为异步修正（对账任务兜底），不能把失败抛给用户
 *     —— 否则会出现「记录其实存下来了，但提示保存失败」的经典二次提交问题
 */

const recordsDao = require('../dao/records');
const dailyDao = require('../dao/dailyAgg');
const statsDao = require('../dao/userStats');
const mediaDao = require('../dao/media');
const audit = require('../dao/auditLogs');
const domain = require('../domain/record');
const ids = require('../core/ids');
const dateUtil = require('../core/date');
const config = require('../core/config');
const logger = require('../core/logger');
const { notFound, bad } = require('../core/errors');

/**
 * 创建记录
 * @returns {{ record: object, duplicated: boolean }}
 */
async function create(userId, payload) {
  const t = logger.timer();
  const doc = domain.normalizeCreate(payload, userId);

  // 幂等：同用户 5 分钟内、同日期同分类同内容的重复提交，直接返回原记录
  doc.idempotencyKey = ids.idempotencyKey({
    userId,
    recordDate: doc.recordDate,
    tag: doc.tag,
    content: doc.content,
    mediaCount: doc.mediaSnap.length,
    bucket: ids.timeBucket(Date.now(), 5)
  });

  const dup = await recordsDao.findByIdempotency(userId, doc.idempotencyKey);
  if (dup) {
    logger.info('record.create 命中幂等', { action: 'record.create', userId, id: dup._id });
    return { record: domain.toDTO(dup), duplicated: true };
  }

  const saved = await recordsDao.insert(doc);
  t.mark('insert');

  // 媒体资产登记：失败不影响主流程，记录里已有快照，展示不受影响
  try {
    const imageMedia = doc.mediaSnap.map(m => ({
      fileID: m.originFileID,
      thumbFileID: m.thumbFileID,
      type: 'image'
    }));
    if (doc.voice) {
      imageMedia.push({ fileID: doc.voice.fileID, type: 'audio', duration: doc.voice.duration });
    }
    if (imageMedia.length) {
      await mediaDao.registerBatch(userId, saved._id, imageMedia);
    }
  } catch (e) {
    logger.warn('媒体登记失败（不影响记录）', { action: 'record.create', err: e && e.message });
  }
  t.mark('media');

  // 读统计全靠这张聚合表，必须先写好；失败则记日志等对账
  try {
    await dailyDao.bumpOnCreate(userId, saved);
  } catch (e) {
    logger.error('日聚合更新失败，待对账修正', {
      action: 'record.create',
      userId,
      id: saved._id,
      err: e && e.message
    });
  }
  t.mark('agg');

  // streak 重算条件：只要落在 streak 观察窗口内就重算。
  // 早先只判「今天/昨天」，补记前两天时连续天数不会变长（今天+昨天+前天本应连成 3 天），
  // 首页和打卡页会一直显示偏小的数值，直到用户下次记今天的东西才被修正。
  // 代价只是点查窗口内的 daily_aggs（≤120 条，走 userId+date 索引）。
  const today = dateUtil.todayKey();
  const back = dateUtil.daysBetween(saved.recordDate, today);
  if (back >= 0 && back <= config.biz.streakWindowDays) {
    try {
      await statsDao.recomputeStreak(userId);
    } catch (e) {
      logger.warn('streak 重算失败', { action: 'record.create', err: e && e.message });
    }
  }
  try {
    await statsDao.bumpTotal(userId, 1);
  } catch (e) {
    logger.warn('累计条数更新失败', { action: 'record.create', err: e && e.message });
  }
  t.mark('stats');

  logger.info('record.create 完成', {
    action: 'record.create',
    userId,
    id: saved._id,
    date: saved.recordDate,
    tag: saved.tag,
    type: saved.typeHint,
    ms: t.elapsed,
    marks: t.marks
  });

  return { record: domain.toDTO(saved), duplicated: false };
}

/** 列表：游标分页 + 条件筛选（日期区间 / 单日 / 标签） */
async function list(userId, query) {
  const q = query || {};
  const limit = Math.min(Number(q.limit) || config.biz.pageSizeDefault, config.biz.pageSizeMax);

  let cursor = null;
  if (q.cursor) {
    // 前端可能传对象（新）或纯 createdAt（老客户端兼容）
    cursor =
      typeof q.cursor === 'object'
        ? q.cursor
        : { date: q.cursorDate || dateUtil.todayKey(), createdAt: Number(q.cursor) };
  }

  const page = await recordsDao.list({
    userId,
    date: q.dayKey,
    startDate: q.startDay,
    endDate: q.endDay,
    tag: q.category,
    cursor,
    limit
  });

  return {
    list: domain.toDTOList(page.list),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor
  };
}

/** 详情：越权与不存在都按「不存在」处理，不泄露资源存在性 */
async function detail(userId, id) {
  if (!id) throw bad('缺少记录 ID');
  const doc = await recordsDao.findOwned(userId, id);
  if (!doc || doc.status === recordsDao.STATUS.DELETED) throw notFound('这条记录可能已被删除');
  return domain.toDTO(doc);
}

/** 软删除：进回收站，30 天后由定时任务物理删除 */
async function remove(userId, id) {
  if (!id) throw bad('缺少记录 ID');
  const doc = await recordsDao.findOwned(userId, id);
  if (!doc || doc.status === recordsDao.STATUS.DELETED) throw notFound('记录不存在');

  await recordsDao.softDelete(id);

  // 后续动作失败都不影响「已删除」这个用户可感知的结果
  try {
    await dailyDao.bumpOnDelete(userId, doc);
  } catch (e) {
    logger.warn('日聚合回减失败，待对账', { action: 'record.remove', err: e && e.message });
  }
  try {
    await statsDao.recomputeStreak(userId);
    await statsDao.bumpTotal(userId, -1);
  } catch (e) {
    logger.warn('统计回减失败', { action: 'record.remove', err: e && e.message });
  }
  try {
    await mediaDao.markOrphan(id);
  } catch (e) {
    logger.warn('媒体标记失败', { action: 'record.remove', err: e && e.message });
  }

  audit.log({ userId, action: audit.ACTIONS.RECORD_DELETE, target: id, result: 'ok' });
  return { ok: true, id };
}

/** 今日视图：记录流 + 当日小计（首页用，一次请求拿全） */
async function today(userId, dayKey) {
  const date = dayKey || dateUtil.todayKey();
  const rows = await recordsDao.listByDate(userId, date, 50);
  const list = domain.toDTOList(rows);

  const agg = await dailyDao.getByDate(userId, date);
  const stats = {
    dayKey: date,
    totalRecords: (agg && agg.recordCount) || list.length,
    sportCount: (agg && agg.byTag && agg.byTag.sport) || 0,
    dietCount: (agg && agg.byTag && agg.byTag.diet) || 0,
    weight: (agg && agg.weight) || null
  };

  return { dayKey: date, records: list, stats };
}

/**
 * 重算某用户的聚合与连续天数（对账 / 定时任务用）
 * 与增量更新是两套实现，故意不同源，才能互相校验
 */
async function reconcileUser(userId, days) {
  const n = days || 7;
  const today = dateUtil.todayKey();
  const dates = dateUtil.recentDays(n, today);
  let fixed = 0;

  for (const date of dates) {
    const rows = await recordsDao.listByDate(userId, date, 200);
    const agg = await dailyDao.getByDate(userId, date);
    const expect = rows.length;
    const actual = (agg && agg.recordCount) || 0;
    if (expect !== actual) {
      await dailyDao.rebuildDay(userId, date, rows);
      fixed++;
      logger.warn('聚合漂移已修正', {
        action: 'reconcile',
        userId,
        date,
        expect,
        actual
      });
    }
  }

  const stats = await statsDao.recomputeStreak(userId);
  const total = await recordsDao.countPublished(userId);
  if (stats.totalRecords !== total) {
    await statsDao.save(userId, { totalRecords: total });
  }

  return { fixed, totalRecords: total, streak: stats.streakCurrent };
}

module.exports = { create, list, detail, remove, today, reconcileUser };
