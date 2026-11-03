/**
 * Mock 仓储：不依赖云开发即可完整跑通全部界面与流程
 * 特性：真实持久化（Storage）+ 分页 + 排序 + 幂等 + 模拟网络延迟
 * 与云端仓储实现同一套契约，见 services/index.js
 */
const dateUtil = require('../utils/date');
const { CATEGORIES, MOODS, findCategory, findMood } = require('../utils/constants');
const template = require('./summary-template');
const config = require('../utils/config');

const K_RECORDS = 'jy_records_v1';
const K_SUMMARIES = 'jy_summaries_v1';
const K_PROFILE = 'jy_profile_v1';

const DAY = 86400000;
// MOCK_DELAY 为 null 时用各调用点给的默认延迟，保持真实体感；
// 本地联调脚本会把它设成 0，让断言不用等网络时间。
const delay = ms =>
  new Promise(r =>
    setTimeout(r, config.MOCK_DELAY === null || config.MOCK_DELAY === undefined ? ms || 160 : config.MOCK_DELAY)
  );
const uid = () => 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ------------------------------------------------------------------ */
/* 种子数据                                                            */
/* ------------------------------------------------------------------ */
function buildSeed() {
  const now = new Date();
  const mk = (offset, hour, minute, payload) => {
    const d = new Date(now);
    d.setDate(d.getDate() - offset);
    d.setHours(hour, minute, 0, 0);
    return Object.assign(
      {
        _id: uid(),
        openid: 'mock_openid_local',
        type: 'text',
        category: 'other',
        content: '',
        mood: '',
        weight: null,
        images: [],
        thumbs: [],
        voice: null,
        dayKey: dateUtil.toDayKey(d),
        createdAt: d.getTime()
      },
      payload
    );
  };

  const plan = [
    [0, 7, 32, { type: 'text', category: 'sport', content: '晨跑 5 公里，配速 6\'20"，风很大但跑起来就不冷了', mood: 'joy' }],
    [0, 8, 5, { type: 'weight', category: 'other', weight: 62.5, content: '体重 62.5 kg' }],
    [0, 12, 20, { type: 'image', category: 'diet', content: '轻食沙拉 + 冰美式', images: ['#C9E8A8', '#E3C39A'], thumbs: ['#C9E8A8', '#E3C39A'] }],
    [0, 14, 5, { type: 'voice', category: 'mood', content: '午后有点闷，下楼走了走，回来好一些', mood: 'low', voice: { fileID: '', duration: 42 } }],
    [1, 8, 10, { type: 'weight', category: 'other', weight: 62.8, content: '体重 62.8 kg' }],
    [1, 21, 15, { type: 'text', category: 'sport', content: '夜跑 3 公里，出汗很舒服', mood: 'calm' }],
    [2, 9, 0, { type: 'text', category: 'sport', content: '健身房练腿，深蹲 4 组', mood: 'joy' }],
    [2, 19, 40, { type: 'image', category: 'diet', content: '自己做了番茄牛腩', images: ['#FFD6CC'], thumbs: ['#FFD6CC'] }],
    [3, 8, 20, { type: 'weight', category: 'other', weight: 63.1, content: '体重 63.1 kg' }],
    [3, 15, 10, { type: 'voice', category: 'mood', content: '会开得有点久，脑子不太转得动', mood: 'tired', voice: { fileID: '', duration: 28 } }],
    [4, 7, 50, { type: 'text', category: 'sport', content: '慢跑 4 公里，心率控制在 145', mood: 'calm' }],
    [4, 12, 30, { type: 'image', category: 'diet', content: '公司楼下的牛肉面', images: ['#E3C39A'], thumbs: ['#E3C39A'] }],
    [5, 10, 0, { type: 'text', category: 'mood', content: '今天什么都没做，但也没觉得浪费', mood: 'calm' }],
    [5, 20, 15, { type: 'weight', category: 'other', weight: 63.4, content: '体重 63.4 kg' }],
    [6, 8, 40, { type: 'text', category: 'sport', content: '羽毛球 1 小时，很久没打这么爽了', mood: 'joy' }],
    [6, 13, 0, { type: 'image', category: 'diet', content: '和朋友吃的早午餐', images: ['#C9E8A8', '#FFD6CC'], thumbs: ['#C9E8A8', '#FFD6CC'] }],
    [7, 9, 5, { type: 'weight', category: 'other', weight: 63.9, content: '体重 63.9 kg' }],
    [7, 22, 30, { type: 'text', category: 'mood', content: '睡前有点焦虑，明天有个汇报', mood: 'anx' }],
    [8, 7, 30, { type: 'text', category: 'sport', content: '晨跑 6 公里，第一次跑到 6 公里', mood: 'joy' }],
    [9, 12, 10, { type: 'image', category: 'diet', content: '点了个轻食外卖', images: ['#C9E8A8'], thumbs: ['#C9E8A8'] }]
  ];

  return plan.map(row => mk(row[0], row[1], row[2], row[3]));
}

function readRecords() {
  let list = wx.getStorageSync(K_RECORDS);
  if (!list || !list.length) {
    list = buildSeed();
    wx.setStorageSync(K_RECORDS, list);
  }
  return list;
}

function writeRecords(list) {
  wx.setStorageSync(K_RECORDS, list);
}

function readProfile() {
  let p = wx.getStorageSync(K_PROFILE);
  if (!p) {
    p = {
      nickname: '阿柠',
      since: '2026-08',
      avatarEmoji: '🦊',
      aiSummary: true,
      reminder: true,
      reminderTime: '21:30'
    };
    wx.setStorageSync(K_PROFILE, p);
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* 聚合计算（Mock 与云端保持同一算法）                                  */
/* ------------------------------------------------------------------ */
function computeStats(records, startDay, endDay) {
  const inRange = records.filter(r => r.dayKey >= startDay && r.dayKey <= endDay);
  const days = Math.max(
    1,
    Math.round((new Date(endDay.replace(/-/g, '/')) - new Date(startDay.replace(/-/g, '/'))) / DAY) + 1
  );

  const weightSorted = inRange
    .filter(r => r.weight !== null && r.weight !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt);

  const weightSeries = weightSorted.map(r => ({ dayKey: r.dayKey, value: r.weight }));
  let weightDelta = null;
  if (weightSorted.length >= 2) {
    weightDelta = +(weightSorted[weightSorted.length - 1].weight - weightSorted[0].weight).toFixed(1);
  }

  const moodCount = {};
  inRange.forEach(r => {
    if (r.mood) moodCount[r.mood] = (moodCount[r.mood] || 0) + 1;
  });
  const moodTotal = Object.values(moodCount).reduce((a, b) => a + b, 0);
  const moodDist = MOODS.map(m => ({
    key: m.key,
    name: m.name,
    color: m.color,
    count: moodCount[m.key] || 0,
    percent: moodTotal ? Math.round(((moodCount[m.key] || 0) / moodTotal) * 100) : 0
  })).filter(m => m.count > 0);
  const moodTop = moodDist.slice().sort((a, b) => b.count - a.count)[0] || null;

  const sportDaysSet = new Set(inRange.filter(r => r.category === 'sport').map(r => r.dayKey));
  const lowDays = inRange.filter(r => r.mood === 'low' || r.mood === 'tired').length;

  const dietByDay = dateUtil.recentDays(days, endDay).map(dayKey => ({
    dayKey,
    count: inRange.filter(r => r.dayKey === dayKey && r.category === 'diet').length
  }));

  // 每天的记录总条数：首页的迷你节奏条用，云端由 daily_aggs 直接给出
  const countByDay = dateUtil.recentDays(days, endDay).map(dayKey => ({
    dayKey,
    count: inRange.filter(r => r.dayKey === dayKey).length
  }));

  return {
    startDay,
    endDay,
    days,
    totalRecords: inRange.length,
    records: inRange,
    sportCount: inRange.filter(r => r.category === 'sport').length,
    sportDays: sportDaysSet.size,
    dietCount: inRange.filter(r => r.category === 'diet').length,
    voiceCount: inRange.filter(r => r.type === 'voice').length,
    imageCount: inRange.filter(r => r.type === 'image' || (r.images && r.images.length)).length,
    weightSeries,
    weightDelta,
    weightCurrent: weightSeries.length ? weightSeries[weightSeries.length - 1].value : null,
    moodDist,
    moodTop,
    moodTotal,
    lowRatio: moodTotal ? lowDays / moodTotal : 0,
    lowAfterSedentary: lowDays >= 2,
    dietByDay,
    countByDay
  };
}

/**
 * 连续天数：与云端 dao/userStats.recomputeStreak 同一套规则
 *   今天有记 → 从今天往前数；今天还没记 → 从昨天往前数（今天还有机会，不算断）
 */
function streakOf(records) {
  const daySet = {};
  records.forEach(r => {
    daySet[r.dayKey] = true;
  });
  const days = Object.keys(daySet).sort();

  let streak = 0;
  let cursor = daySet[dateUtil.todayKey()] ? dateUtil.todayKey() : dateUtil.shiftDay(-1);
  while (daySet[cursor]) {
    streak++;
    cursor = dateUtil.toDayKey(new Date(new Date(cursor.replace(/-/g, '/')).getTime() - DAY));
  }

  let longest = 0;
  let run = 0;
  let prev = null;
  days.forEach(d => {
    const gap = prev ? new Date(d.replace(/-/g, '/')) - new Date(prev.replace(/-/g, '/')) : -1;
    run = gap === DAY ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  });

  return { streak, longest: Math.max(longest, streak), days };
}

/* ------------------------------------------------------------------ */
/* 对外契约                                                             */
/* ------------------------------------------------------------------ */
module.exports = {
  name: 'mock',

  async listRecords({ dayKey, startDay, endDay, category, cursor, limit } = {}) {
    await delay(120);
    let list = readRecords();
    if (dayKey) list = list.filter(r => r.dayKey === dayKey);
    if (startDay) list = list.filter(r => r.dayKey >= startDay);
    if (endDay) list = list.filter(r => r.dayKey <= endDay);
    if (category) list = list.filter(r => r.category === category);

    list = list.sort((a, b) => b.createdAt - a.createdAt);
    if (cursor) list = list.filter(r => r.createdAt < cursor);

    const size = limit || config.PAGE_SIZE;
    const page = list.slice(0, size);
    return {
      list: page,
      hasMore: list.length > size,
      nextCursor: page.length ? page[page.length - 1].createdAt : null
    };
  },

  async getRecord(id) {
    await delay(80);
    const list = readRecords();
    const hit = list.find(r => r._id === id);
    if (!hit) {
      const err = new Error('记录不存在');
      err.friendly = '这条记录可能已被删除';
      throw err;
    }
    return hit;
  },

  async createRecord(payload) {
    await delay(220);
    if (!payload || (!payload.content && !payload.weight && !(payload.images || []).length && !payload.voice)) {
      const err = new Error('empty');
      err.friendly = '写点什么再保存吧';
      throw err;
    }
    const now = Date.now();
    const record = Object.assign(
      {
        _id: uid(),
        openid: 'mock_openid_local',
        type: 'text',
        category: 'other',
        content: '',
        mood: '',
        weight: null,
        images: [],
        thumbs: [],
        voice: null,
        dayKey: dateUtil.todayKey(),
        createdAt: now
      },
      payload
    );
    const list = readRecords();
    list.unshift(record);
    writeRecords(list);
    return record;
  },

  async removeRecord(id) {
    await delay(160);
    const list = readRecords().filter(r => r._id !== id);
    writeRecords(list);
    return { ok: true };
  },

  async getToday() {
    const dayKey = dateUtil.todayKey();
    const res = await this.listRecords({ dayKey, limit: 50 });
    const all = readRecords();
    const stats = computeStats(all, dayKey, dayKey);
    return { dayKey, records: res.list, stats };
  },

  async getStats({ startDay, endDay }) {
    await delay(180);
    const all = readRecords();
    return computeStats(all, startDay, endDay);
  },

  async getCheckin() {
    await delay(140);
    const all = readRecords();
    const s = streakOf(all);
    const days = s.days;
    const monthKey = dateUtil.toMonthKey(new Date());
    const monthCount = days.filter(d => d.indexOf(monthKey) === 0).length;
    const total = all.length;

    return {
      streak: s.streak,
      longest: s.longest,
      checkedDays: days,
      monthCount,
      // 徽章规则必须与云端 dao/userStats.js 的 BADGES 完全一致，
      // 否则演示（Mock）和真机（云端）看到的徽章数量不一样
      badges: [
        { key: 'd3', emoji: '🌱', name: '3 天起步', unlocked: s.streak >= 3 },
        { key: 'd7', emoji: '🥇', name: '7 天坚持', unlocked: s.streak >= 7 },
        { key: 'd21', emoji: '🏆', name: '21 天破纪录', unlocked: s.streak >= 21 },
        { key: 'd60', emoji: '🔥', name: '60 天不断', unlocked: s.streak >= 60 },
        { key: 'first', emoji: '✍️', name: '第一笔', unlocked: total >= 1 },
        { key: 'rich', emoji: '📚', name: '记录 100 条', unlocked: total >= 100 }
      ]
    };
  },

  async getProfile() {
    await delay(80);
    const p = readProfile();
    const all = readRecords();
    const s = streakOf(all);
    // streak / longest 与云端 profile 返回保持一致（页面虽然另取 checkin，但字段不能缺）
    return Object.assign({}, p, {
      totalRecords: all.length,
      photoCount: all.filter(r => (r.images || []).length).length,
      voiceCount: all.filter(r => r.type === 'voice').length,
      streak: s.streak,
      longest: s.longest
    });
  },

  async updateProfile(patch) {
    await delay(120);
    const p = Object.assign(readProfile(), patch || {});
    wx.setStorageSync(K_PROFILE, p);
    return p;
  },

  /**
   * 读取已生成的总结
   * 行为与云端 summary.get 严格一致：没生成过就是 null，由页面显示「生成总结」空态。
   * （早先这里会自动用模板造一份，导致 Mock 演示和真机表现不同，联调时容易误判。）
   */
  async getSummary({ type = 'week' } = {}) {
    await delay(150);
    const store = wx.getStorageSync(K_SUMMARIES) || {};
    const key = `${type}_${dateUtil.periodRange(type).periodKey}`;
    return store[key] || null;
  },

  async generateSummary({ type = 'week' } = {}) {
    await delay(700); // 模拟生成耗时
    const range = dateUtil.periodRange(type);
    const key = `${type}_${range.periodKey}`;
    const stats = computeStats(readRecords(), range.startKey, range.endKey);
    const summary = Object.assign(
      template.build({ records: stats.records, stats, type, periodKey: range.periodKey }),
      { status: 'ready', periodType: type, periodKey: range.periodKey, stale: false }
    );
    const store = wx.getStorageSync(K_SUMMARIES) || {};
    store[key] = summary;
    wx.setStorageSync(K_SUMMARIES, store);
    return summary;
  },

  /** 测试辅助：清空本地数据 */
  async resetMock() {
    wx.removeStorageSync(K_RECORDS);
    wx.removeStorageSync(K_SUMMARIES);
    return { ok: true };
  }
};

module.exports._internal = { computeStats, findCategory, findMood, CATEGORIES };
