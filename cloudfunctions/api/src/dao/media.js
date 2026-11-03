/**
 * media_assets DAO
 *
 * 为什么记录只在 mediaSnap 里冗余必要字段、而不是全部存记录里：
 *   - media_assets 承担配额统计、审核状态、清理，与记录的生命周期解耦
 *   - records 里存一份最小快照（originFileID / thumbFileID / 宽高），列表页就不用
 *     每条记录再查一次 media，一次查询拿到全部展示信息
 *
 * 关键坑：不要把「临时 URL」写进库。
 *   云存储 getTempFileURL 出来的链接 2 小时过期，写库后第二天列表图片全白。
 *   所以这里存 fileID（cloud://...），前端 image 组件可直接渲染 fileID。
 */

const { db, COL } = require('../core/db');
const { mediaId } = require('../core/ids');
const { getById } = require('./base');

/**
 * 批量登记媒体资产（记录创建前由前端上传完成，这里做服务端二次校验与入库）
 * @param {Array} items [{fileID, thumbFileID, type, size, width, height, duration}]
 */
async function registerBatch(userId, recordId, items) {
  if (!items || !items.length) return [];
  const now = Date.now();
  const snaps = [];

  for (const it of items) {
    const id = mediaId();
    const doc = {
      _id: id,
      userId,
      recordId: recordId || '',
      type: it.type || 'image',
      fileID: it.fileID || '',
      thumbFileID: it.thumbFileID || it.fileID || '',
      objectKey: it.objectKey || '',
      size: Number(it.size) || 0,
      mime: it.mime || (it.type === 'audio' ? 'audio/mp4' : 'image/jpeg'),
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
      duration: Number(it.duration) || 0,
      status: 'passed', // 内容安全异步检测命中后改 rejected
      createdAt: now
    };
    try {
      await db.collection(COL.media).add({ data: doc });
    } catch (e) {
      // 媒体入库失败不能阻断记录创建，降级为「记录里只留快照」
      console.warn('[media] 资产入库失败，仅保留快照', e && e.message);
    }
    snaps.push({
      mediaId: id,
      originFileID: doc.fileID,
      thumbFileID: doc.thumbFileID,
      width: doc.width,
      height: doc.height,
      duration: doc.duration,
      type: doc.type
    });
  }
  return snaps;
}

/** 记录与媒体绑定（先传图后建记录的场景） */
async function bindToRecord(userId, recordId, mediaIds) {
  for (const id of mediaIds || []) {
    const m = await getById(COL.media, id);
    if (m && m.userId === userId && !m.recordId) {
      await db.collection(COL.media).doc(id).update({ data: { recordId } });
    }
  }
}

/** 用户媒体占用字节数（配额页用，按 userId 索引聚合，不分页） */
async function sumBytes(userId) {
  const res = await db
    .collection(COL.media)
    .where({ userId })
    .field({ size: true })
    .limit(1000)
    .get();
  return (res.data || []).reduce((s, m) => s + (m.size || 0), 0);
}

/** 记录删除后异步清理媒体（先标记，由定时任务真实删除，避免删除拖慢接口） */
async function markOrphan(recordId) {
  const res = await db.collection(COL.media).where({ recordId }).field({ _id: true }).limit(100).get();
  const ids = (res.data || []).map(m => m._id);
  for (const id of ids) {
    await db.collection(COL.media).doc(id).update({ data: { status: 'orphan', orphanAt: Date.now() } });
  }
  return ids.length;
}

/** 取记录的媒体文件 ID 列表（兜底：记录里没快照时回查） */
async function listByRecord(recordId) {
  const res = await db
    .collection(COL.media)
    .where({ recordId })
    .orderBy('createdAt', 'asc')
    .limit(20)
    .get();
  return res.data || [];
}

module.exports = { registerBatch, bindToRecord, sumBytes, markOrphan, listByRecord };
