/**
 * 数据库句柄与集合定义
 * 集合口径严格对齐技术文档 4.2/4.3：
 *   users / records / media_assets / daily_aggs / user_stats
 *   ai_summaries / ai_quota / reminders / audit_logs
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COL = {
  users: 'users',
  records: 'records',
  media: 'media_assets',
  daily: 'daily_aggs',
  stats: 'user_stats',
  summaries: 'ai_summaries',
  quota: 'ai_quota',
  reminders: 'reminders',
  audit: 'audit_logs'
};

/** 归档集合名：records_202611（按月归档开启后才用） */
function archiveCollection(recordDate) {
  return `records_${String(recordDate).slice(0, 7).replace('-', '')}`;
}

/**
 * 文档版本迁移：读时向上兼容，不跑全量刷库（技术文档 4.9）
 * 每条文档带 schemaVer，新增字段在这里补默认值即可。
 */
const CURRENT_SCHEMA = 2;

function migrateRecord(doc) {
  if (!doc) return doc;
  const v = doc.schemaVer || 1;

  // v1 → v2：从旧字段名（openid/dayKey/category/images）升级到文档口径
  if (v < 2) {
    if (!doc.userId && doc.openid) doc.userId = doc.openid;
    if (!doc.recordDate && doc.dayKey) doc.recordDate = doc.dayKey;
    if (!doc.tag && doc.category) doc.tag = doc.category;
    if (!doc.mediaSnap && doc.images) {
      doc.mediaSnap = (doc.images || []).map((originFileID, i) => ({
        mediaId: '',
        originFileID,
        thumbFileID: (doc.thumbs || [])[i] || originFileID
      }));
    }
    if (!doc.detail) doc.detail = {};
    if (doc.detail.weight === undefined && doc.weight !== undefined) doc.detail.weight = doc.weight;
    if (!doc.status) doc.status = doc.deleted ? 'deleted' : 'published';
    doc.schemaVer = 2;
  }
  return doc;
}

module.exports = {
  cloud,
  db,
  _,
  COL,
  CURRENT_SCHEMA,
  archiveCollection,
  migrateRecord
};
