/**
 * 日期工具：全部基于本地时区，dayKey 是整个应用的时间主轴
 * dayKey 形如 2026-11-02，用于按天分组、聚合、打卡判定
 */

const pad = n => (n < 10 ? '0' + n : '' + n);

/** Date → '2026-11-02' */
function toDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date → '2026-11' */
function toMonthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 今天 dayKey */
function todayKey() {
  return toDayKey(new Date());
}

/** 时间戳 → 'HH:mm' */
function toTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 时间戳 → '14:05'；今天显示时间，跨天显示 'M.D' */
function toFriendlyTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (toDayKey(d) === toDayKey(now)) return toTime(ts);
  return `${d.getMonth() + 1}.${pad(d.getDate())}`;
}

/** '2026-11-02' → '11月2日' */
function prettyDay(dayKey) {
  const [y, m, d] = dayKey.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

/** '2026-11-02' → '周一' */
function weekday(dayKey) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return names[new Date(dayKey.replace(/-/g, '/')).getDay()];
}

/** 今天/昨天/11月2日 */
function dayLabel(dayKey) {
  const t = todayKey();
  if (dayKey === t) return '今天';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (dayKey === toDayKey(y)) return '昨天';
  return prettyDay(dayKey);
}

/** 相对今天的日期偏移，返回 dayKey */
function shiftDay(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toDayKey(d);
}

/** 本周一 00:00 的 Date */
function weekStart(date) {
  const d = new Date(date || Date.now());
  const day = d.getDay() || 7; // 周日按 7 算
  d.setDate(d.getDate() - day + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 近 N 天 dayKey 数组，升序 */
function recentDays(n, endDayKey) {
  const end = endDayKey ? new Date(endDayKey.replace(/-/g, '/')) : new Date();
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    list.push(toDayKey(d));
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* 周期口径：必须与云函数 core/date.js 完全一致                          */
/* 前后端各算一次周期是最容易出错的地方：前端「近 7 天」、后端「本周」，   */
/* 用户看到的总结数据和总结正文就会对不上。                              */
/* ------------------------------------------------------------------ */
const DAY_MS = 86400000;

/** dayKey → UTC 毫秒（只做日期运算，不对应真实时区） */
function parseDayUTC(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** UTC 毫秒 → dayKey */
function fromUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** dayKey 平移：shiftDayKey('2026-11-02', -7) === '2026-10-26' */
function shiftDayKey(key, offset) {
  return fromUTC(parseDayUTC(key) + offset * DAY_MS);
}

/** 该周周一（国内习惯，周一为一周起点） */
function weekStartKey(key) {
  const base = parseDayUTC(key);
  const dow = new Date(base).getUTCDay(); // 0 = 周日
  return fromUTC(base - (dow === 0 ? 6 : dow - 1) * DAY_MS);
}

/** ISO 周编号：2026-W45 */
function weekKeyOf(key) {
  const monday = weekStartKey(key);
  const thursday = parseDayUTC(monday) + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const dow = new Date(jan1).getUTCDay();
  const firstThursday = jan1 - (dow === 0 ? 6 : dow - 1) * DAY_MS + 3 * DAY_MS;
  const week = Math.floor((thursday - firstThursday) / (7 * DAY_MS)) + 1;
  return `${year}-W${pad(week)}`;
}

/**
 * 周期区间，与云函数 periodRange 同口径
 * @param {'day'|'week'|'month'} periodType
 * @param {string} refKey 参考日，默认今天
 * @returns {{startKey:string,endKey:string,periodKey:string}}
 */
function periodRange(periodType, refKey) {
  const ref = refKey || todayKey();
  if (periodType === 'day') {
    return { startKey: ref, endKey: ref, periodKey: ref };
  }
  if (periodType === 'week') {
    const start = weekStartKey(ref);
    return { startKey: start, endKey: shiftDayKey(start, 6), periodKey: weekKeyOf(ref) };
  }
  if (periodType === 'month') {
    const start = ref.slice(0, 7) + '-01';
    const [y, m] = ref.slice(0, 7).split('-').map(Number);
    const nextMonthFirst = m === 12 ? Date.UTC(y + 1, 0, 1) : Date.UTC(y, m, 1);
    return { startKey: start, endKey: fromUTC(nextMonthFirst - DAY_MS), periodKey: ref.slice(0, 7) };
  }
  throw new Error('未知周期类型: ' + periodType);
}

/** 记录列表 → [{ dayKey, label, items }] 分组 */
function groupByDay(records) {
  const map = {};
  const order = [];
  records.forEach(r => {
    if (!map[r.dayKey]) {
      map[r.dayKey] = [];
      order.push(r.dayKey);
    }
    map[r.dayKey].push(r);
  });
  return order.map(dayKey => ({
    dayKey,
    label: dayLabel(dayKey),
    weekday: weekday(dayKey),
    count: map[dayKey].length,
    items: map[dayKey]
  }));
}

module.exports = {
  pad,
  toDayKey,
  toMonthKey,
  todayKey,
  toTime,
  toFriendlyTime,
  prettyDay,
  weekday,
  dayLabel,
  shiftDay,
  weekStart,
  recentDays,
  groupByDay,
  shiftDayKey,
  weekStartKey,
  weekKeyOf,
  periodRange
};
