/**
 * 我的（M3 设置 + 个人数据）
 * 开关采用「先改 UI 再落库，失败回滚」的乐观更新，避免开关卡顿
 */
const repo = require('../../services/index');
const dateUtil = require('../../utils/date');
const feedback = require('../../utils/feedback');
const config = require('../../utils/config');

Page({
  data: {
    loading: true,
    nickname: '阿柠',
    avatarEmoji: '🦊',
    since: '',
    daysTogether: 0,

    totalRecords: 0,
    photoCount: 0,
    voiceCount: 0,
    streak: 0,

    aiSummary: true,
    reminder: true,
    reminderTime: '21:30',

    useMock: config.USE_MOCK,
    version: '1.0.0'
  },

  onLoad() {
    this.load();
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 4 });

    const app = getApp();
    if (app.globalData.needRefresh) {
      app.globalData.needRefresh = false;
      this.load();
    }
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const [profile, checkin] = await Promise.all([repo.getProfile(), repo.getCheckin()]);
      const since = profile.since || '';
      let daysTogether = 0;
      if (since) {
        const start = new Date(since.replace(/-/g, '/') + '/01');
        daysTogether = Math.max(1, Math.round((Date.now() - start.getTime()) / 86400000));
      }
      this.setData({
        loading: false,
        nickname: profile.nickname || '阿柠',
        avatarEmoji: profile.avatarEmoji || '🦊',
        since: since ? since.replace('-', ' 年 ') + ' 月' : '',
        daysTogether,
        totalRecords: profile.totalRecords || 0,
        photoCount: profile.photoCount || 0,
        voiceCount: profile.voiceCount || 0,
        streak: (checkin && checkin.streak) || 0,
        aiSummary: profile.aiSummary !== false,
        reminder: profile.reminder !== false,
        reminderTime: profile.reminderTime || '21:30'
      });
    } catch (err) {
      this.setData({ loading: false });
      feedback.fail(err, '个人信息没加载出来');
    }
  },

  /* ------------------------------------------------------------------ */
  /* 开关                                                                */
  /* ------------------------------------------------------------------ */
  async onToggle(e) {
    const field = e.currentTarget.dataset.field;
    const next = e.detail.value;
    const backup = this.data[field];

    this.setData({ [field]: next });
    try {
      await repo.updateProfile({ [field]: next });
    } catch (err) {
      this.setData({ [field]: backup }); // 失败回滚，别让开关显示的状态骗人
      feedback.fail(err, '设置没保存成功');
    }
  },

  onPickTime(e) {
    const value = e.detail.value;
    this.setData({ reminderTime: value });
    repo.updateProfile({ reminderTime: value }).catch(err => feedback.fail(err, '时间没保存成功'));
  },

  /* ------------------------------------------------------------------ */
  /* 导航                                                                */
  /* ------------------------------------------------------------------ */
  goCheckin() {
    wx.navigateTo({ url: '/pkgA/checkin/checkin' });
  },

  goSummary() {
    wx.navigateTo({ url: '/pkgA/summary/summary?type=week' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pkgA/settings/settings' });
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pkgA/settings/settings?section=privacy' });
  },

  onExport() {
    feedback.toast('导出功能在 V1.1 开放');
  },

  /** 开发期辅助：一键重置本地 Mock，方便反复验收 */
  async onResetMock() {
    if (!config.USE_MOCK) {
      feedback.toast('当前已连接真实数据，不能重置');
      return;
    }
    const yes = await feedback.confirm('会清空本地 Mock 记录，恢复到初始示例数据。确定吗？', '重置演示数据');
    if (!yes) return;
    try {
      await repo.resetMock();
      getApp().globalData.needRefresh = true;
      feedback.ok('已重置');
      setTimeout(() => this.load(), 400);
    } catch (err) {
      feedback.fail(err, '重置失败');
    }
  }
});
