const { TABS } = require('../utils/constants');

Component({
  data: {
    selected: 0,
    tabs: TABS,
    safeBottom: 0
  },

  lifetimes: {
    attached() {
      const app = getApp();
      const safeBottom = (app && app.globalData && app.globalData.safeBottom) || 0;
      this.setData({ safeBottom });
    }
  },

  methods: {
    onTap(e) {
      const index = Number(e.currentTarget.dataset.index);
      const tab = this.data.tabs[index];
      if (!tab) return;

      // 中间「记录」不是 tabBar 页面，只能用 navigateTo；
      // 其余四个用 switchTab，且已选中的不重复跳转（switchTab 会丢页面栈）
      if (tab.center) {
        wx.navigateTo({
          url: tab.path,
          fail: () => wx.showToast({ title: '页面暂时打不开', icon: 'none' })
        });
        return;
      }
      if (index === this.data.selected) return;

      wx.switchTab({
        url: tab.path,
        fail: () => {
          wx.showToast({ title: '页面暂时打不开', icon: 'none' });
        }
      });
    }
  }
});
