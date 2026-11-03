/**
 * 设置（M3）
 * 含：通知、隐私入口、缓存管理、环境信息（开发期自检用）
 * 提审注意：隐私相关入口必须真实可用，不能只是摆设（以官方审核规范为准）
 */
const repo = require('../../services/index');
const feedback = require('../../utils/feedback');
const config = require('../../utils/config');

Page({
  data: {
    loading: true,
    aiSummary: true,
    reminder: true,
    reminderTime: '21:30',

    cacheText: '0 KB',
    useMock: config.USE_MOCK,
    envText: '',
    baseVersion: '',
    version: '1.0.0',
    highlightPrivacy: false
  },

  onLoad(query) {
    if (query && query.section === 'privacy') {
      this.setData({ highlightPrivacy: true });
    }
    this.load();
  },

  async load() {
    try {
      const profile = await repo.getProfile();
      this.setData({
        loading: false,
        aiSummary: profile.aiSummary !== false,
        reminder: profile.reminder !== false,
        reminderTime: profile.reminderTime || '21:30',
        envText: config.USE_MOCK
          ? '本地 Mock（数据存在手机本地）'
          : '云开发' + (config.CLOUD_ENV_ID ? ' · ' + config.CLOUD_ENV_ID : ' · 默认环境'),
        baseVersion: this.getBaseVersion()
      });
      this.refreshCache();
    } catch (err) {
      this.setData({ loading: false });
      feedback.fail(err, '设置没加载出来');
    }
  },

  getBaseVersion() {
    try {
      const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
      return info.SDKVersion || '';
    } catch (e) {
      return '';
    }
  },

  refreshCache() {
    try {
      const info = wx.getStorageInfoSync();
      const kb = info.currentSize || 0;
      this.setData({
        cacheText: kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'
      });
    } catch (e) {
      this.setData({ cacheText: '--' });
    }
  },

  async onToggle(e) {
    const field = e.currentTarget.dataset.field;
    const next = e.detail.value;
    const backup = this.data[field];
    this.setData({ [field]: next });
    try {
      await repo.updateProfile({ [field]: next });
      if (field === 'reminder' && next) {
        feedback.toast('上线后需申请订阅消息授权才会真正推送');
      }
    } catch (err) {
      this.setData({ [field]: backup });
      feedback.fail(err, '设置没保存成功');
    }
  },

  onPickTime(e) {
    const value = e.detail.value;
    this.setData({ reminderTime: value });
    repo.updateProfile({ reminderTime: value }).catch(err => feedback.fail(err, '时间没保存成功'));
  },

  /* ---------------- 隐私与协议 ---------------- */

  /** 打开微信官方的隐私保护指引设置页（用户可在此撤销授权） */
  openPrivacySetting() {
    if (wx.openPrivacyContract) {
      wx.openPrivacyContract({
        fail: () => feedback.toast('暂时打不开，请在微信设置中管理')
      });
    } else {
      feedback.toast('请升级微信后使用');
    }
  },

  showAgreement() {
    wx.showModal({
      title: '用户协议',
      content:
        '「记一天」仅用于记录个人生活数据。你记录的文字、图片、语音仅归属于你本人，不会公开展示或提供给第三方。可随时在设置中删除全部数据。',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#17161A'
    });
  },

  showPrivacyPolicy() {
    wx.showModal({
      title: '隐私保护指引',
      content:
        '我们收集：你主动填写的内容、拍摄/选择的照片、录制的语音、体重数值。用途：生成你的个人记录与 AI 总结。存储：微信云开发（中国境内）。不会用于广告或对外共享。',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#17161A'
    });
  },

  /* ---------------- 数据 ---------------- */

  async onClearCache() {
    const yes = await feedback.confirm('只清理本地缓存与图片临时文件，不会删除你的记录。继续吗？', '清理缓存');
    if (!yes) return;
    try {
      // 保留业务数据 key，只清临时缓存
      const keep = ['jy_records_v1', 'jy_summaries_v1', 'jy_profile_v1', 'jy_draft_v1'];
      const info = wx.getStorageInfoSync();
      (info.keys || []).forEach(k => {
        if (keep.indexOf(k) < 0) wx.removeStorageSync(k);
      });
      this.refreshCache();
      feedback.ok('清理完成');
    } catch (e) {
      feedback.fail(e, '清理失败');
    }
  },

  async onResetMock() {
    if (!config.USE_MOCK) {
      feedback.toast('当前是真实数据，不能重置');
      return;
    }
    const yes = await feedback.confirm('会清空本地演示记录，恢复初始示例数据。确定吗？', '重置演示数据');
    if (!yes) return;
    try {
      await repo.resetMock();
      getApp().globalData.needRefresh = true;
      feedback.ok('已重置');
    } catch (err) {
      feedback.fail(err, '重置失败');
    }
  },

  showAbout() {
    wx.showModal({
      title: '关于记一天',
      content:
        'v1.0.0\n一个只给自己看的生活记录本。\n运动、饮食、心情、体重，随手记一笔，AI 帮你看出变化。',
      showCancel: false,
      confirmText: '哦了',
      confirmColor: '#17161A'
    });
  }
});
