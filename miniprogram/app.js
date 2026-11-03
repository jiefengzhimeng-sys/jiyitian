const config = require('./utils/config');

App({
  globalData: {
    openid: '',          // 当前用户 openid（Mock 模式下为本地虚拟 id）
    statusBarHeight: 20, // 状态栏高度 px
    navHeight: 64,       // 状态栏 + 导航栏内容区（px）
    safeBottom: 0,       // 底部安全区 px
    cloudReady: false,
    // 跨页通信：记录新增后置 true，首页/时间线/统计 onShow 时消费
    needRefresh: false
  },

  onLaunch() {
    this.measureLayout();
    if (!config.USE_MOCK) {
      this.initCloud();
    } else {
      this.globalData.openid = 'mock_openid_local';
      this.globalData.cloudReady = true;
    }
    this.checkPrivacy();
  },

  /** 量一次布局，nav-bar 组件与自定义 tabBar 都用得上 */
  measureLayout() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const statusBarHeight = info.statusBarHeight || 20;
      const safeArea = info.safeArea;
      const screenHeight = info.screenHeight || info.windowHeight || 0;
      const safeBottom = safeArea && screenHeight ? Math.max(screenHeight - safeArea.bottom, 0) : 0;
      this.globalData.statusBarHeight = statusBarHeight;
      this.globalData.navHeight = statusBarHeight + 44;
      this.globalData.safeBottom = safeBottom;
    } catch (e) {
      console.warn('[记一天] 布局测量失败，使用兜底值', e);
    }
  },

  initCloud() {
    if (!wx.cloud) {
      console.error('[记一天] 当前基础库不支持云开发，请使用 2.2.3 以上版本');
      return;
    }
    const opts = { traceUser: true };
    if (config.CLOUD_ENV_ID) opts.env = config.CLOUD_ENV_ID;

    wx.cloud.init(opts);
    this.globalData.cloudReady = true;

    // 换取 openid（session_key 全程留在云端，前端只拿 openid 做数据归属，见 E-03）
    wx.cloud
      .callFunction({ name: config.API_FN, data: { action: 'user.init' } })
      .then(res => {
        if (res.result && res.result.data && res.result.data.openid) {
          this.globalData.openid = res.result.data.openid;
        }
      })
      .catch(err => console.warn('[记一天] 获取 openid 失败', err));
  },

  /** 隐私合规：用户未同意隐私保护指引时，首次触及隐私接口会走微信标准弹窗 */
  checkPrivacy() {
    if (!wx.getPrivacySetting) return;
    wx.getPrivacySetting({
      success: res => {
        this.globalData.needPrivacy = !!res.needAuthorization;
      },
      fail: () => {}
    });
  },

  /** 调用录音/相册等隐私接口前调用，未授权则触发微信标准隐私弹窗 */
  requirePrivacy() {
    return new Promise(resolve => {
      if (!wx.requirePrivacyAuthorize) return resolve(true);
      wx.requirePrivacyAuthorize({
        success: () => resolve(true),
        fail: () => {
          wx.showToast({ title: '需同意隐私保护指引后才能继续', icon: 'none' });
          resolve(false);
        }
      });
    });
  }
});
