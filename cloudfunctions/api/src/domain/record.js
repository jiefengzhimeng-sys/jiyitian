/**
 * records 领域模型：输入校验 + 存储结构与前端 DTO 的双向映射
 *
 * 为什么要有这一层：
 *   存储层用文档口径（userId/recordDate/tag/detail/mediaSnap/status），
 *   前端契约用的是早期字段名（openid/dayKey/category/images/thumbs/voice）。
 *   映射集中在一个文件里，将来前端改字段只改映射，不动 DAO，也不动表结构。
 */

const validate = require('../core/validate');
const { bad } = require('../core/errors');
const config = require('../core/config');
const dateUtil = require('../core/date');
const ids = require('../core/ids');
const { CURRENT_SCHEMA } = require('../core/db');

const TAGS = ['sport', 'diet', 'mood', 'weight', 'other'];
const TYPES = ['text', 'voice', 'image', 'weight'];
const MOODS = ['joy', 'calm', 'low', 'angry', 'anx', 'tired'];

/**
 * 校验并归一化创建入参
 * 注意：客户端传的 userId / status / recordDate 一律不信任，
 *      userId 由调用方（入口处）注入，recordDate 由服务端按补记规则校验。
 */
function normalizeCreate(payload, userId) {
  const p = payload || {};

  const content = validate.str(p.content, '文字', { max: config.biz.maxContentLen });
  const tag = validate.oneOf(p.category, '记录类型', TAGS, { default: 'other' });
  const mood = p.mood ? validate.oneOf(p.mood, '心情', MOODS, { default: '' }) : '';

  // 体重既可能出现在 detail 里，也可能走顶层 weight（前端契约）
  const rawWeight = p.weight !== undefined ? p.weight : p.detail && p.detail.weight;
  const weight =
    rawWeight === null || rawWeight === undefined || rawWeight === ''
      ? null
      : validate.num(rawWeight, '体重', { min: config.biz.minWeight, max: config.biz.maxWeight });

  const images = validate.arr(p.images, '图片', { max: config.biz.maxImages });
  const thumbs = validate.arr(p.thumbs, '缩略图');
  const voice = p.voice && (p.voice.fileID || p.voice.path)
    ? {
        fileID: p.voice.fileID || p.voice.path,
        duration: validate.num(p.voice.duration, '语音时长', { max: 60, default: 0 })
      }
    : null;

  // 至少要有一种内容，否则是空记录
  if (!content && !images.length && !voice && weight === null) {
    throw bad('写点什么再保存吧');
  }

  // 归属日期：默认今天；允许补记但限制回溯天数
  const today = dateUtil.todayKey();
  let recordDate = p.dayKey || p.recordDate || today;
  validate.dayKey(recordDate, '日期');
  const back = dateUtil.daysBetween(recordDate, today);
  if (back < 0) throw bad('还没到的日子不能记');
  if (back > config.biz.backfillDays) {
    throw bad(`最多补记 ${config.biz.backfillDays} 天内的记录`);
  }

  // 类型：只有体重就记 weight，优先级 voice > image > text（与前端 resolveType 一致）
  let typeHint = p.type;
  if (TYPES.indexOf(typeHint) < 0) {
    if (weight !== null && !content && !images.length && !voice) typeHint = 'weight';
    else if (voice) typeHint = 'voice';
    else if (images.length) typeHint = 'image';
    else typeHint = 'text';
  }

  // 媒体快照：origin 用于大图，thumb 用于列表。
  // 只接受 fileID / 本地路径，不接受 http 临时链接（2 小时会过期）
  const mediaSnap = images.map((originFileID, i) => ({
    mediaId: '',
    originFileID,
    thumbFileID: thumbs[i] || originFileID,
    type: 'image'
  }));

  return {
    userId,
    content,
    tag,
    mood,
    typeHint,
    detail: Object.assign({}, p.detail || {}, weight !== null ? { weight } : {}),
    mediaSnap,
    voice,
    recordDate,
    source: back > 0 ? 'backfill' : 'normal',
    status: 'published',
    // 单调时间戳：同毫秒连续写入不会撞点，否则游标翻页会把同毫秒的记录整批漏掉
    createdAt: ids.nextTimestamp(),
    updatedAt: Date.now(),
    deletedAt: null,
    schemaVer: CURRENT_SCHEMA
  };
}

/**
 * 存储文档 → 前端 DTO
 * 前端页面用的是 type/category/images/thumbs/weight/dayKey，这里全部补齐。
 * images 返回 origin fileID，thumbs 返回 thumb fileID：
 *   小程序 image 组件可直接渲染 cloud:// 开头的 fileID，无需换临时链接。
 */
function toDTO(doc) {
  if (!doc) return null;
  const snap = doc.mediaSnap || [];
  const detail = doc.detail || {};
  return {
    _id: doc._id,
    type: doc.typeHint || 'text',
    category: doc.tag || 'other',
    content: doc.content || '',
    mood: doc.mood || '',
    weight: typeof detail.weight === 'number' ? detail.weight : null,
    images: snap.map(m => m.originFileID).filter(Boolean),
    thumbs: snap.map(m => m.thumbFileID || m.originFileID).filter(Boolean),
    voice: doc.voice ? { fileID: doc.voice.fileID, duration: doc.voice.duration || 0 } : null,
    dayKey: doc.recordDate,
    createdAt: doc.createdAt,
    source: doc.source || 'normal'
  };
}

/** 列表批量映射，顺手过滤掉脏数据（老版本结构可能缺字段） */
function toDTOList(docs) {
  return (docs || []).map(toDTO).filter(Boolean);
}

module.exports = { TAGS, TYPES, MOODS, normalizeCreate, toDTO, toDTOList };
