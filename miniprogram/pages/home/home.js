const app = getApp();
const repo = require('../../services/index');
const dateUtil = require('../../utils/date');
const { findMood } = require('../../utils/constants');
const feedback = require('../../utils/feedback');

// 情绪天气地图：把六档情绪翻译成一句人话
const WEATHER = {
  joy: { title: '今天的心情，像午后的太阳', desc: '适合把这种状态记下来' },
  calm: { title: '今天的情绪，有点像下午四点的阴天', desc: '不浓不淡，刚刚好' },
  low: { title: '今天有点闷，像下过雨的天', desc: '记录下来就已经很好了' },
  angry: { title: '今天心里有团火', desc: '写两句，火会小一点' },
  anx: { title: '今天脑子转得有点快', desc: '把担心的写出来，会轻一些' },
  tired: { title: '今天电量不太够', desc: '先记一笔，然后早点休息' }
};

Page({
  data: {
    greeting: '',
    dateText: '',
    streak: 0,
    loading: true,
    records: [],
    hasRecords: false,
    moodTitle: '今天，想记点什么？',
    moodDesc: '一句话、一张照片，都算今天的痕迹',
    moodEmoji: '✍️',
    bars: [],
    quick: [
      { key: 'sport', name: '运动', emoji: '🏃', wash: '#E6F4FF' },
      { key: 'diet', name: '饮食', emoji: '🥗', wash: '#E2F9F0' },
      { key: 'mood', name: '心情', emoji: '💭', wash: '#FFF6DE' },
      { key: 'weight', name: '体重', emoji: '⚖️', wash: '#F0EBFF' },
      { key: 'image', name: '拍照', emoji: '📷', wash: '#FFEDE8' }
    ]
  },

  onLoad() {
    this.setGreeting();
  },

  onShow() {
    // 自定义 tabBar 的选中态需要页面自己同步
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 0 });

    // 记录保存后回到首页，消费一次刷新标记（避免 onShow 无脑重复请求，见 E-07）
    if (app.globalData.needRefresh) {
      app.globalData.needRefresh = false;
    }
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData(true);
  },

  setGreeting() {
    const h = new Date().getHours();
    let greeting = '晚上好';
    if (h < 5) greeting = '还没睡呀';
    else if (h < 11) greeting = '早上好';
    else if (h < 14) greeting = '中午好';
    else if (h < 18) greeting = '下午好';

    const now = new Date();
    this.setData({
      greeting,
      dateText: `${now.getMonth() + 1}月${now.getDate()}日 ${dateUtil.weekday(dateUtil.todayKey())}`
    });
  },

  async loadData(isPull) {
    const todayKey = dateUtil.todayKey();
    const startDay = dateUtil.recentDays(7, todayKey)[0];

    try {
      const [todayRes, weekStats, checkin] = await Promise.all([
        repo.getToday(),
        repo.getStats({ startDay, endDay: todayKey }),
        repo.getCheckin()
      ]);

      const records = (todayRes && todayRes.records) || [];
      const moodRecords = records.filter(r => !!r.mood);
      const dominant = this.pickDominantMood(moodRecords);
      const weather = dominant ? WEATHER[dominant] || null : null;

      // 近 7 天的记录量柱条（情绪卡底部的小节奏条）
      // 优先用聚合好的 countByDay：云端不会为这个需求返回全量记录
      const byDay = {};
      if (weekStats && weekStats.countByDay) {
        weekStats.countByDay.forEach(d => {
          byDay[d.dayKey] = d.count;
        });
      } else {
        ((weekStats && weekStats.records) || []).forEach(r => {
          byDay[r.dayKey] = (byDay[r.dayKey] || 0) + 1;
        });
      }
      const days = dateUtil.recentDays(7, todayKey);
      const counts = days.map(d => byDay[d] || 0);
      const max = Math.max.apply(null, counts.concat([1]));

      this.setData({
        loading: false,
        records,
        hasRecords: records.length > 0,
        streak: (checkin && checkin.streak) || 0,
        moodTitle: weather ? weather.title : '今天，想记点什么？',
        moodDesc: weather ? weather.desc : `已记 ${records.length} 条，再补一笔就完整了`,
        moodEmoji: (dominant && findMood(dominant)) ? findMood(dominant).emoji : '✍️',
        bars: counts.map(c => Math.max(Math.round((c / max) * 100), 12))
      });
    } catch (err) {
      this.setData({ loading: false });
      feedback.fail(err, '今天的数据没加载出来');
    } finally {
      if (isPull) wx.stopPullDownRefresh();
    }
  },

  /** 今日出现最多的情绪 */
  pickDominantMood(moodRecords) {
    if (!moodRecords.length) return '';
    const count = {};
    moodRecords.forEach(r => {
      count[r.mood] = (count[r.mood] || 0) + 1;
    });
    return Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  },

  onQuickTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'image') {
      wx.navigateTo({ url: '/pages/record/record?tab=image&category=diet' });
      return;
    }
    if (key === 'weight') {
      wx.navigateTo({ url: '/pages/record/record?tab=text&focus=weight' });
      return;
    }
    wx.navigateTo({ url: `/pages/record/record?category=${key}` });
  },

  onRecordTap(e) {
    const id = e.detail.id;
    if (!id) return;
    wx.navigateTo({ url: `/pkgA/detail/detail?id=${id}` });
  },

  goTimeline() {
    wx.switchTab({ url: '/pages/timeline/timeline' });
  },

  goCheckin() {
    wx.navigateTo({ url: '/pkgA/checkin/checkin' });
  },

  goRecord() {
    wx.navigateTo({ url: '/pages/record/record' });
  }
});
