/**
 * 轻反馈：与 UI 稿一致 —— 不用全屏弹窗，用底部浮条
 */
function toast(title) {
  wx.showToast({ title, icon: 'none', duration: 1800 });
}

function ok(title) {
  wx.showToast({ title, icon: 'success', duration: 1500 });
}

function loading(title) {
  wx.showLoading({ title: title || '处理中', mask: true });
}

function hideLoading() {
  wx.hideLoading();
}

/** 统一的错误兜底：不把技术错误直接抛给用户 */
function fail(err, fallback) {
  console.error('[记一天]', err);
  const msg = fallback || (err && err.friendly) || '网络不太好，稍后再试';
  wx.showToast({ title: msg, icon: 'none', duration: 2000 });
}

/** 确认框（Promise 化） */
function confirm(content, title) {
  return new Promise(resolve => {
    wx.showModal({
      title: title || '确认一下',
      content,
      confirmColor: '#17161A',
      cancelColor: '#8E8B96',
      success: res => resolve(!!res.confirm),
      fail: () => resolve(false)
    });
  });
}

module.exports = { toast, ok, loading, hideLoading, fail, confirm };
