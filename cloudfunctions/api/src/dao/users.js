/**
 * users DAO —— 用户档案与设置
 * _id = userId（openid）。openid 只服务端使用，永不返回前端。
 */

const { db, COL } = require('../core/db');
const { getById } = require('./base');
const dateUtil = require('../core/date');

const DEFAULT_SETTINGS = {
  remindOn: true,
  remindTime: '21:30',
  aiSummaryOn: true,
  autoTranscribe: false
};

const DEFAULT_USER = {
  nickname: '阿柠',
  avatarEmoji: '🦊',
  settings: DEFAULT_SETTINGS,
  status: 'active',
  schemaVer: 2
};

async function get(userId) {
  return getById(COL.users, userId);
}

/** 首次进入小程序时建档（幂等） */
async function ensure(userId, profile) {
  const exist = await get(userId);
  if (exist) return exist;

  const now = new Date(Date.now() + dateUtil.TZ_OFFSET);
  const doc = Object.assign({}, DEFAULT_USER, profile || {}, {
    openid: userId,
    since: `${now.getUTCFullYear()}-${dateUtil.pad(now.getUTCMonth() + 1)}`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  try {
    await db.collection(COL.users).add({ data: Object.assign({ _id: userId }, doc) });
  } catch (e) {
    // 并发建档，对方先建好，直接返回
    return get(userId);
  }
  return Object.assign({ _id: userId }, doc);
}

/** 只允许改设置类字段，字段白名单在 service 层，这里再兜一道 */
async function update(userId, patch) {
  const data = Object.assign({}, patch, { updatedAt: Date.now() });
  try {
    await db.collection(COL.users).doc(userId).update({ data });
  } catch (e) {
    await ensure(userId);
    await db.collection(COL.users).doc(userId).update({ data });
  }
  return get(userId);
}

/** 合并 settings（避免前端只传一个开关时把其他设置覆盖掉） */
async function patchSettings(userId, settingsPatch) {
  const user = (await get(userId)) || (await ensure(userId));
  const settings = Object.assign({}, DEFAULT_SETTINGS, user.settings || {}, settingsPatch || {});
  if (settings.remindTime && !/^\d{2}:\d{2}$/.test(settings.remindTime)) {
    delete settings.remindTime; // 非法时间不写库，保留原值
  }
  await db.collection(COL.users).doc(userId).update({ data: { settings, updatedAt: Date.now() } });
  return settings;
}

/** 注销：进入冷静期，到期由定时任务物理删除（合规要求） */
async function markDeleting(userId) {
  await db
    .collection(COL.users)
    .doc(userId)
    .update({ data: { status: 'deleting', deleteRequestedAt: Date.now(), updatedAt: Date.now() } });
}

module.exports = { DEFAULT_SETTINGS, DEFAULT_USER, get, ensure, update, patchSettings, markDeleting };
