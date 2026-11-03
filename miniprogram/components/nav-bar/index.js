const app = getApp();

Component({
  options: { multipleSlots: true },

  properties: {
    title: { type: String, value: '' },
    back: { type: Boolean, value: false },
    /** light: 纸底深字；clear: 透明（用于沉浸式页面） */
    theme: { type: String, value: 'light' }
  },

  data: {
    statusBarHeight: 20
  },

  lifetimes: {
    attached() {
      const g = (app && app.globalData) || {};
      this.setData({ statusBarHeight: g.statusBarHeight || 20 });
    }
  },

  methods: {
    onBack() {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.switchTab({ url: '/pages/home/home' });
      }
    }
  }
});
