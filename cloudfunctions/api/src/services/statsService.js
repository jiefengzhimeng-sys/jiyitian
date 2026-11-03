/**
 * 统计业务逻辑
 *
 * 核心原则：所有统计都从 daily_aggs 汇总，绝不实时扫 records。
 *   7 天 = 7 条、30 天 = 30 条、90 天 = 90 条，无论用户记了 10 条还是 1 万条，
 *   这个接口的耗时都是常量级。
 *
 * 返回结构与前端数据页契约一一对应（前端不再做二次加工）。
 */

const dailyDao = require('../dao/dailyAgg');
const dateUtil = require('../core/date');
const { bad } = require('../core/errors');

// 与小程序 utils/constants.js 的 MOODS 保持一致
const MOOD_META = {
  joy: { name: '开心', color: '#FFC857' },
  calm: { name: '平静', color: '#7CC5FF' },
  low: { name: '低落', color: '#8E8B96' },
  angry: { name: '烦躁', color: '#FF6B4A' },
  anx: { name: '焦虑', color: '#B9A7FF' },
  tired: { name: '疲惫', color: '#A9C0B4' }
};

/**
 * 区间统计概览
 * @param {string} userId
 * @param {object} range {startDay, endDay} 缺省为近 7 天
 */
async function overview(userId, range) {
  const q = range || {};
  const endDay = q.endDay || dateUtil.todayKey();
  const startDay = q.startDay || dateUtil.shiftDay(endDay, -6);
  const span = dateUtil.daysBetween(startDay, endDay) + 1;

  // 防御：超过 180 天的区间没有业务场景，只会拖慢接口
  if (span > 180) {
    throw bad('一次最多看 180 天的统计');
  }

  const aggs = await dailyDao.getRange(userId, startDay, endDay);

  // 按日期建索引，缺失的日子补 0（图表需要连续的 X 轴，不能断点）
  const byDate = {};
  aggs.forEach(a => {
    byDate[a.date] = a;
  });
  const days = dateUtil.rangeDays(startDay, endDay);

  let totalRecords = 0;
  let sportCount = 0;
  let dietCount = 0;
  let sportDays = 0;
  let voiceCount = 0;
  let imageCount = 0;
  const moodCount = {};
  const weightSeries = [];
  let lastWeight = null;

  days.forEach(d => {
    const a = byDate[d];
    const byTag = (a && a.byTag) || {};
    const count = (a && a.recordCount) || 0;

    totalRecords += count;
    sportCount += byTag.sport || 0;
    dietCount += byTag.diet || 0;
    if ((byTag.sport || 0) > 0) sportDays++;
    voiceCount += (a && a.voiceCount) || 0;
    imageCount += (a && a.mediaCount) || 0;

    Object.keys((a && a.moodCounts) || {}).forEach(k => {
      const v = a.moodCounts[k];
      if (v > 0) moodCount[k] = (moodCount[k] || 0) + v;
    });

    if (a && typeof a.weight === 'number' && a.weight > 0) {
      weightSeries.push({ dayKey: d, value: a.weight });
      lastWeight = a.weight;
    }
  });

  const moodTotal = Object.values(moodCount).reduce((s, v) => s + v, 0);
  const moodDist = Object.keys(moodCount)
    .map(k => {
      const meta = MOOD_META[k] || { name: k, color: '#B9A7FF' };
      return {
        key: k,
        name: meta.name,
        color: meta.color,
        count: moodCount[k],
        percent: moodTotal ? Math.round((moodCount[k] / moodTotal) * 100) : 0
      };
    })
    .sort((a, b) => b.count - a.count);

  const lowCount = (moodCount.low || 0) + (moodCount.tired || 0);

  return {
    startDay,
    endDay,
    days: span,
    totalRecords,
    sportCount,
    sportDays,
    dietCount,
    voiceCount,
    imageCount,
    weightSeries,
    weightDelta:
      weightSeries.length >= 2
        ? +(weightSeries[weightSeries.length - 1].value - weightSeries[0].value).toFixed(1)
        : null,
    weightCurrent: lastWeight,
    moodDist,
    moodTop: moodDist[0] || null,
    moodTotal,
    lowRatio: moodTotal ? +(lowCount / moodTotal).toFixed(2) : 0,
    lowAfterSedentary: lowCount >= 2,
    countByDay: days.map(d => ({ dayKey: d, count: (byDate[d] && byDate[d].recordCount) || 0 })),
    dietByDay: days.map(d => ({
      dayKey: d,
      count: (byDate[d] && byDate[d].byTag && byDate[d].byTag.diet) || 0
    }))
  };
}

/** 打卡数据：连续天数、本月点阵、徽章 */
async function checkin(userId) {
  const statsDao = require('../dao/userStats');
  const stats = await statsDao.get(userId);
  const monthKey = dateUtil.todayKey().slice(0, 7);
  const checkedDays = await dailyDao.listMonthDates(userId, monthKey);

  return {
    streak: stats.streakCurrent || 0,
    longest: stats.streakMax || 0,
    checkedDays,
    monthCount: checkedDays.length,
    monthKey,
    totalRecords: stats.totalRecords || 0,
    badges: statsDao.resolveBadges(stats)
  };
}

/** 用户档案：把 settings 展开成前端用的平铺字段 */
async function profile(userId) {
  const usersDao = require('../dao/users');
  const statsDao = require('../dao/userStats');
  const { db, COL } = require('../core/db');

  const user = (await usersDao.get(userId)) || (await usersDao.ensure(userId));
  const stats = await statsDao.get(userId);
  const settings = user.settings || usersDao.DEFAULT_SETTINGS;

  // 照片数 / 语音数：前端「我的」页要展示，走 count 而不是拉列表
  // 两个 count 都是用户维度，命中 userId 索引，用户几千条记录时也在 20ms 内
  const [photoCount, voiceCount] = await Promise.all([
    db.collection(COL.media).where({ userId, type: 'image' }).count().then(r => r.total || 0).catch(() => 0),
    db.collection(COL.records).where({ userId, status: 'published', typeHint: 'voice' }).count().then(r => r.total || 0).catch(() => 0)
  ]);

  return {
    nickname: user.nickname || '阿柠',
    avatarEmoji: user.avatarEmoji || '🦊',
    since: user.since || '',
    aiSummary: settings.aiSummaryOn !== false,
    reminder: settings.remindOn !== false,
    reminderTime: settings.remindTime || '21:30',
    totalRecords: stats.totalRecords || 0,
    photoCount,
    voiceCount,
    streak: stats.streakCurrent || 0,
    longest: stats.streakMax || 0
  };
}

/** 更新档案：字段白名单，防止客户端改 status / openid 之类 */
async function updateProfile(userId, patch) {
  const usersDao = require('../dao/users');
  const p = patch || {};
  const allowFlat = ['nickname', 'avatarEmoji'];
  const docPatch = {};
  allowFlat.forEach(k => {
    if (p[k] !== undefined) docPatch[k] = String(p[k]).slice(0, 32);
  });

  const settingsPatch = {};
  if (p.aiSummary !== undefined) settingsPatch.aiSummaryOn = !!p.aiSummary;
  if (p.reminder !== undefined) settingsPatch.remindOn = !!p.reminder;
  if (p.reminderTime !== undefined) settingsPatch.remindTime = String(p.reminderTime);

  await usersDao.ensure(userId);
  if (Object.keys(docPatch).length) await usersDao.update(userId, docPatch);
  if (Object.keys(settingsPatch).length) await usersDao.patchSettings(userId, settingsPatch);

  // 提醒设置同步到 reminders 表（定时任务扫的是这张）
  // 只有真的改了提醒相关字段才写，避免「改个昵称」也去动提醒表
  const reminderPatch = {};
  if (settingsPatch.remindOn !== undefined) reminderPatch.remindOn = settingsPatch.remindOn;
  if (settingsPatch.remindTime !== undefined) reminderPatch.remindTime = settingsPatch.remindTime;
  if (Object.keys(reminderPatch).length) {
    const remindersDao = require('../dao/reminders');
    await remindersDao.save(userId, reminderPatch);
  }

  return profile(userId);
}

module.exports = { MOOD_META, overview, checkin, profile, updateProfile };
