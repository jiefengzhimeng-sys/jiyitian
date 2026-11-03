/**
 * user_stats DAO —— 用户维度累计值，_id = userId
 *
 * streak 为什么要重算而不是纯增量：
 *   「连续天数」依赖「昨天是否记过」，跨天后昨天的状态变了，增量无法表达。
 *   所以 streak 由「写记录时触发 + 每日定时任务兜底」重算，成本是点查近 120 天的
 *   daily_aggs（≤120 条），比扫 records 便宜两个数量级。
 */

const { db, COL } = require('../core/db');
const { getById, inc } = require('./base');
const dateUtil = require('../core/date');

/** 徽章规则集中放这里，改规则不用翻业务代码 */
const BADGES = [
  { key: 'd3', emoji: '🌱', name: '3 天起步', need: s => s.streakCurrent >= 3 },
  { key: 'd7', emoji: '🥇', name: '7 天坚持', need: s => s.streakCurrent >= 7 },
  { key: 'd21', emoji: '🏆', name: '21 天破纪录', need: s => s.streakCurrent >= 21 },
  { key: 'd60', emoji: '🔥', name: '60 天不断', need: s => s.streakCurrent >= 60 },
  { key: 'first', emoji: '✍️', name: '第一笔', need: s => s.totalRecords >= 1 },
  { key: 'rich', emoji: '📚', name: '记录 100 条', need: s => s.totalRecords >= 100 }
];

const DEFAULT_STATS = {
  streakCurrent: 0,
  streakMax: 0,
  lastRecordDate: '',
  totalRecords: 0,
  mediaBytes: 0,
  monthCount: 0,
  badges: [],
  updatedAt: 0
};

async function get(userId) {
  const doc = await getById(COL.stats, userId);
  return Object.assign({}, DEFAULT_STATS, doc || {});
}

/** 只对已存在字段做自增，避免把整个文档建出来（建档在 users.ensure 里做） */
async function bumpTotal(userId, delta) {
  try {
    await db
      .collection(COL.stats)
      .doc(userId)
      .update({ data: Object.assign(inc({ totalRecords: delta }), { updatedAt: Date.now() }) });
  } catch (e) {
    // 文档不存在则补建
    await save(
      userId,
      Object.assign({}, DEFAULT_STATS, { totalRecords: Math.max(0, delta), updatedAt: Date.now() })
    );
  }
}

async function save(userId, patch) {
  const data = Object.assign({}, patch, { updatedAt: Date.now() });
  delete data._id;
  try {
    await db.collection(COL.stats).doc(userId).update({ data });
  } catch (e) {
    await db
      .collection(COL.stats)
      .add({ data: Object.assign({ _id: userId }, DEFAULT_STATS, data) });
  }
  return get(userId);
}

/**
 * 依据 daily_aggs 重算 streak（连续天数）
 * 规则：今天有记 → 从今天往前数；今天没记 → 从昨天往前数（今天还有机会，不算断）
 */
async function recomputeStreak(userId) {
  const today = dateUtil.todayKey();
  const since = dateUtil.shiftDay(today, -120);
  const dates = await require('./dailyAgg').listActiveDates(userId, since, 200);

  if (!dates.length) {
    return save(userId, { streakCurrent: 0, streakMax: 0, lastRecordDate: '' });
  }

  const set = {};
  dates.forEach(d => {
    set[d] = true;
  });

  let cursor = set[today] ? today : dateUtil.shiftDay(today, -1);
  let current = 0;
  while (set[cursor]) {
    current++;
    cursor = dateUtil.shiftDay(cursor, -1);
  }

  // 历史最长：升序扫一遍，相邻差 1 天就累加
  const asc = dates.slice().sort();
  let max = 0;
  let run = 0;
  let prev = null;
  asc.forEach(d => {
    run = prev && dateUtil.daysBetween(prev, d) === 1 ? run + 1 : 1;
    if (run > max) max = run;
    prev = d;
  });

  return save(userId, {
    streakCurrent: current,
    streakMax: Math.max(max, current),
    lastRecordDate: asc[asc.length - 1]
  });
}

/** 按当前 stats 计算徽章（幂等，可重复调用） */
function resolveBadges(stats) {
  const unlocked = BADGES.filter(b => {
    try {
      return b.need(stats);
    } catch (e) {
      return false;
    }
  }).map(b => b.key);
  return BADGES.map(b => ({
    key: b.key,
    emoji: b.emoji,
    name: b.name,
    unlocked: unlocked.indexOf(b.key) >= 0
  }));
}

module.exports = { BADGES, DEFAULT_STATS, get, save, bumpTotal, recomputeStreak, resolveBadges };
