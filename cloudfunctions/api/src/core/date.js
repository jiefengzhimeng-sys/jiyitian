/**
 * 日期工具（全项目唯一时间口径）
 *
 * 为什么要自己算时区：
 *   微信云函数运行时默认时区是 UTC，直接 new Date().getDate() 在 UTC 16:00 之后
 *   （北京时间 0 点之后）会拿到"昨天"，导致 dayKey 错一天、streak 断档、
 *   0 点后记的内容被算到前一天。这类 bug 极难在白天测试时发现。
 *   所以本文件所有计算都基于固定 UTC+8 偏移，与运行环境时区无关。
 */

const TZ_OFFSET = 8 * 3600 * 1000;
const DAY = 86400000;

const pad = n => (n < 10 ? '0' + n : '' + n);

/** 把「现在」平移到北京时间轴，用 getUTC* 读出来就是北京时间的年月日 */
function nowShifted() {
  return new Date(Date.now() + TZ_OFFSET);
}

/** 今天的 dayKey：YYYY-MM-DD（北京时间） */
function todayKey() {
  const d = nowShifted();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** dayKey → 当天 0 点的 UTC 毫秒（仅用于日期运算，不对应真实时区） */
function parseDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 日期平移：shiftDay('2026-11-02', -7) === '2026-10-26' */
function shiftDay(key, offset) {
  return fromUTC(parseDay(key) + offset * DAY);
}

/** 两日期相差天数（b - a） */
function daysBetween(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / DAY);
}

/** 周一为一周起点（国内习惯），返回该周的周一 */
function weekStart(key) {
  const base = parseDay(key);
  const dow = new Date(base).getUTCDay(); // 0=周日
  const back = dow === 0 ? 6 : dow - 1;
  return fromUTC(base - back * DAY);
}

/** ISO 周编号：2026-W44 */
function weekKey(key) {
  const monday = weekStart(key);
  // ISO 周所属年份按「该周周四」所在的年份算，避免跨年周算错
  const thursday = parseDay(monday) + 3 * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const firstThursday = (() => {
    const jan1 = Date.UTC(year, 0, 1);
    const dow = new Date(jan1).getUTCDay();
    // 1 月 1 日所在周的周四
    const back = dow === 0 ? 6 : dow - 1;
    return jan1 - back * DAY + 3 * DAY;
  })();
  const week = Math.floor((thursday - firstThursday) / (7 * DAY)) + 1;
  return `${year}-W${pad(week)}`;
}

/** 月 key：2026-11 */
function monthKey(key) {
  return String(key).slice(0, 7);
}

/** 闭区间日期序列：rangeDays('2026-10-30','2026-11-02') → 4 个 key */
function rangeDays(startKey, endKey) {
  const out = [];
  const end = parseDay(endKey);
  for (let t = parseDay(startKey); t <= end; t += DAY) out.push(fromUTC(t));
  return out;
}

/** 近 N 天（含今天）的 key 列表，升序 */
function recentDays(n, endKey) {
  const end = endKey || todayKey();
  return rangeDays(shiftDay(end, -(n - 1)), end);
}

/**
 * 周期区间。periodType: day | week | month
 * refKey 为参考日（默认今天），返回 { startKey, endKey, periodKey }
 * 说明：periodKey 是「周期唯一标识」，用于 ai_summaries 的 _id 与配额去重。
 *      week 用 ISO 周（2026-W44）而不是周一日期，跨年不会撞号。
 */
function periodRange(periodType, refKey) {
  const ref = refKey || todayKey();
  if (periodType === 'day') {
    return { startKey: ref, endKey: ref, periodKey: ref };
  }
  if (periodType === 'week') {
    const start = weekStart(ref);
    return { startKey: start, endKey: shiftDay(start, 6), periodKey: weekKey(ref) };
  }
  if (periodType === 'month') {
    const start = monthKey(ref) + '-01';
    const [y, m] = monthKey(ref).split('-').map(Number);
    // 下月 1 日减 1 天 = 本月最后一天，避开 28/29/30/31 的判断
    const nextMonthFirst = m === 12 ? Date.UTC(y + 1, 0, 1) : Date.UTC(y, m, 1);
    return { startKey: start, endKey: fromUTC(nextMonthFirst - DAY), periodKey: monthKey(ref) };
  }
  throw new Error('未知周期类型: ' + periodType);
}

/** 上一个完整周期（定时任务预生成用） */
function prevPeriodRange(periodType, refKey) {
  const cur = periodRange(periodType, refKey);
  const anchor = shiftDay(cur.startKey, -1);
  return periodRange(periodType, anchor);
}

/** 友好标签：11月2日 / 第44周 / 2026年11月 */
function periodLabel(periodType, range) {
  if (periodType === 'day') {
    const [, m, d] = range.startKey.split('-');
    return `${Number(m)}月${Number(d)}日`;
  }
  if (periodType === 'week') return `第${Number(range.periodKey.split('-W')[1])}周`;
  const [, m] = range.startKey.split('-');
  return `${Number(m)}月`;
}

module.exports = {
  DAY,
  TZ_OFFSET,
  pad,
  todayKey,
  parseDay,
  fromUTC,
  shiftDay,
  daysBetween,
  weekStart,
  weekKey,
  monthKey,
  rangeDays,
  recentDays,
  periodRange,
  prevPeriodRange,
  periodLabel
};
