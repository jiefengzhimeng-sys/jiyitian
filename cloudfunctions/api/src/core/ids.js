/**
 * ID 与键生成
 * 云开发没有自增主键，业务上要靠「确定性 _id」来天然去重：
 *   daily_aggs  → {userId}_{YYYY-MM-DD}   一天一条，省掉查重
 *   user_stats  → {userId}
 *   ai_summaries→ {userId}_{periodType}_{periodKey}
 *   ai_quota    → {userId}_{YYYY-MM-DD}_{periodType}
 * 这样「先查再写」的竞态就消失了，直接 upsert 即可。
 */

const crypto = require('crypto');

/** 短随机串，用于媒体 id */
function rand(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** 记录 id：时间前缀 + 随机，天然按创建时间有序，便于排查 */
function recordId() {
  return `r${Date.now().toString(36)}${rand(8)}`;
}

function mediaId() {
  return `m${Date.now().toString(36)}${rand(6)}`;
}

const dayAggId = (userId, date) => `${userId}_${date}`;
const summaryId = (userId, periodType, periodKey) => `${userId}_${periodType}_${periodKey}`;
const quotaId = (userId, date, periodType) => `${userId}_${date}_${periodType}`;

/**
 * 幂等键归一化
 * 前端可能重试提交（网络抖动点两次），用「内容指纹」做幂等：
 * 同用户 + 同日期 + 同分类 + 同内容 + 同图片数 + 5 分钟窗口内 → 视为同一条。
 * 不用时间戳做键，因为重试时时间戳必然不同。
 */
function idempotencyKey({ userId, recordDate, tag, content, mediaCount, bucket }) {
  const raw = [userId, recordDate, tag, (content || '').trim().slice(0, 120), mediaCount || 0, bucket || ''].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

/** 把「现在」切成 5 分钟一个桶，用于幂等窗口 */
function timeBucket(ms, sizeMin) {
  const size = (sizeMin || 5) * 60 * 1000;
  return Math.floor((ms || Date.now()) / size);
}

/**
 * 单调递增时间戳
 *
 * 为什么不能直接用 Date.now()：
 *   时间线用 (recordDate, createdAt) 复合游标翻页，条件是 createdAt < cursor。
 *   同一毫秒写入的多条记录 createdAt 相同 → 翻页时这些「兄弟记录」会被条件排除，
 *   整批消失（联调实测：16 条记录三页只翻出 13 条，少的那 3 条正是同毫秒写入的）。
 *   本函数保证同一实例内时间戳严格递增，撞点消失；跨实例同毫秒的极端情况由
 *   前端 mergeGroups 按 _id 去重兜底（宁可重复，不能丢）。
 */
let lastTs = 0;
function nextTimestamp() {
  const now = Date.now();
  lastTs = now > lastTs ? now : lastTs + 1;
  return lastTs;
}

module.exports = {
  rand,
  recordId,
  mediaId,
  dayAggId,
  summaryId,
  quotaId,
  idempotencyKey,
  timeBucket,
  nextTimestamp
};
