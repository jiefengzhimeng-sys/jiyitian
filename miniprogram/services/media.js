/**
 * 媒体处理：上传前压缩 + 云存储上传
 * 技术方案：一份原图 + 两档派生（thumb 320 / preview 1080），列表只用 thumb
 * 说明：小程序端不做图片裁切派生，压缩在客户端完成后再分别上传，
 *      云端如需实时派生请开启云存储的图片处理能力（以腾讯云/微信官方文档核实）
 */
const config = require('../utils/config');

/** 压缩图片；不支持时原样返回，保证功能不断 */
function compress(src, quality) {
  return new Promise(resolve => {
    if (!wx.compressImage) return resolve(src);
    wx.compressImage({
      src,
      quality: quality || 70,
      success: res => resolve(res.tempFilePath || src),
      fail: () => resolve(src)
    });
  });
}

/** 取图片尺寸（用于判断是否需要二次压缩） */
function getImageInfo(src) {
  return new Promise(resolve => {
    wx.getImageInfo({
      src,
      success: res => resolve(res),
      fail: () => resolve(null)
    });
  });
}

/** 长边超过 2000px 的图，先压一道再上传，避免原图几十 MB */
async function normalize(src) {
  const info = await getImageInfo(src);
  if (info && Math.max(info.width, info.height) > 2000) {
    return compress(src, 62);
  }
  return compress(src, 78);
}

function cloudPath(openid, ext) {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : n);
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `records/${openid}/${day}/${Date.now()}_${rand}.${ext || 'jpg'}`;
}

/**
 * 上传单张图片，返回 { thumbFileID, originFileID }
 * Mock 模式：直接返回本地临时路径，不产生网络请求
 */
async function uploadImage(src, openid) {
  if (config.USE_MOCK || !wx.cloud) {
    return { thumbFileID: src, originFileID: src, mock: true };
  }
  const normalized = await normalize(src);
  const [thumbRes, originRes] = await Promise.all([
    wx.cloud.uploadFile({ cloudPath: cloudPath(openid, 'jpg'), filePath: normalized }),
    wx.cloud.uploadFile({ cloudPath: cloudPath(openid, 'jpg'), filePath: src })
  ]);
  return {
    thumbFileID: thumbRes.fileID,
    originFileID: originRes.fileID,
    mock: false
  };
}

/** 上传语音 */
async function uploadVoice(tempFilePath, openid, duration) {
  if (config.USE_MOCK || !wx.cloud) {
    return { fileID: tempFilePath, duration, mock: true };
  }
  const res = await wx.cloud.uploadFile({
    cloudPath: cloudPath(openid, 'mp3'),
    filePath: tempFilePath
  });
  return { fileID: res.fileID, duration, mock: false };
}

/** fileID → 可展示的临时链接（云存储文件需要转换） */
async function resolveTempURL(fileIDs) {
  const ids = (fileIDs || []).filter(i => i && i.indexOf('cloud://') === 0);
  if (!ids.length || !wx.cloud) return {};
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: ids });
    const map = {};
    (res.fileList || []).forEach(f => {
      if (f.tempFileURL) map[f.fileID] = f.tempFileURL;
    });
    return map;
  } catch (e) {
    console.warn('[记一天] 获取临时链接失败', e);
    return {};
  }
}

module.exports = { compress, normalize, uploadImage, uploadVoice, resolveTempURL };
