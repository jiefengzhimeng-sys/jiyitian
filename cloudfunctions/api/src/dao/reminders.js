/**
 * reminders DAO —— 打卡提醒与订阅消息记录
 *
 * 订阅消息是一次性授权：用户点一次「允许」只能收到一条消息。
 * 所以这里存的是「剩余可发次数」，每次发送成功扣 1，发完就不发，
 * 前端再引导用户点一次订阅。不做这件事的话，提醒功能上线第一天就会失效。
 */

const { db, _, COL } = require('../core/db');
const { getById } = require('./base');
const dateUtil = require('../core/date');

const DEFAULT = {
  remindOn: true,
  remindTime: '21:30',
  // 订阅消息剩余额度（微信一次性订阅）
  quotaLeft: 0,
  lastSentAt: 0,
  lastSentDate: '',
  sentCount: 0,
  updatedAt: 0
};

async function get(userId) {
  const doc = await getById(COL.reminders, userId);
  return Object.assign({}, DEFAULT, doc || {});
}

/** 只写有值的字段：undefined 会被云开发当成「非法值」或写成空，
 *  最典型的后果是把 remindOn 写成 undefined，listDue 里 remindOn:true 就永远扫不到人 */
function stripUndefined(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(k => {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

async function save(userId, patch) {
  const data = Object.assign(stripUndefined(patch), { updatedAt: Date.now() });
  try {
    await db.collection(COL.reminders).doc(userId).update({ data });
  } catch (e) {
    await db
      .collection(COL.reminders)
      .add({ data: Object.assign({ _id: userId, userId }, DEFAULT, data) });
  }
  return get(userId);
}

/** 用户点击「允许订阅」后累加额度 */
async function addQuota(userId, n) {
  const cur = await get(userId);
  return save(userId, { quotaLeft: Math.max(0, (cur.quotaLeft || 0) + (n || 1)) });
}

/**
 * 扫描待发送的提醒
 * 条件：开关打开 + 时间已到 + 今天还没发 + 有剩余额度
 * 用 remindTime 字符串比较即可（HH:mm 定长，字典序等于时间序）
 */
async function listDue(nowTime, limit) {
  const today = dateUtil.todayKey();
  const res = await db
    .collection(COL.reminders)
    .where({
      remindOn: true,
      remindTime: _.lte(nowTime),
      quotaLeft: _.gt(0),
      lastSentDate: _.neq(today)
    })
    .limit(limit || 100)
    .get();
  return res.data || [];
}

/** 发送成功后扣额度，并记录日期防同一天重复发 */
async function markSent(userId) {
  const cur = await get(userId);
  return save(userId, {
    quotaLeft: Math.max(0, (cur.quotaLeft || 0) - 1),
    lastSentAt: Date.now(),
    lastSentDate: dateUtil.todayKey(),
    sentCount: (cur.sentCount || 0) + 1
  });
}

module.exports = { DEFAULT, get, save, addQuota, listDue, markSent };
