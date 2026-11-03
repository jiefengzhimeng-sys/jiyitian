/**
 * 时间线（M4）
 * 分页策略：游标分页（createdAt < cursor），不用 skip —— 用户记录多了也不会越翻越慢
 * 分组策略：一次拉一页 → 前端按 dayKey 分组，跨页时合并同一天
 */
const repo = require('../../services/index');
const dateUtil = require('../../utils/date');
const { CATEGORIES } = require('../../utils/constants');
const feedback = require('../../utils/feedback');

const MODES = [
  { key: 'day', name: '今天', days: 1 },
  { key: 'week', name: '近 7 天', days: 7 },
  { key: 'month', name: '近 30 天', days: 30 }
];

Page({
  data: {
    modes: MODES,
    mode: 'week',
    rangeText: '',

    filters: [{ key: '', name: '全部' }].concat(
      CATEGORIES.map(c => ({ key: c.key, name: c.name }))
    ),
    filter: '',

    groups: [],
    total: 0,
    loading: true,
    loadingMore: false,
    hasMore: true,
    cursor: null,
    isEmpty: false
  },

  onLoad() {
    this.load(true);
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 1 });

    const app = getApp();
    if (app.globalData.needRefresh) {
      app.globalData.needRefresh = false;
      this.load(true);
    }
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  /* ------------------------------------------------------------------ */
  /* 数据                                                                */
  /* ------------------------------------------------------------------ */
  getRange() {
    const mode = MODES.find(m => m.key === this.data.mode) || MODES[1];
    const endDay = dateUtil.todayKey();
    const startDay = dateUtil.recentDays(mode.days, endDay)[0];
    return { startDay, endDay };
  },

  async load(reset) {
    if (reset) {
      this.setData({ loading: true, cursor: null, hasMore: true });
    }
    const { startDay, endDay } = this.getRange();
    this.setData({ rangeText: this.buildRangeText(startDay, endDay) });

    try {
      const res = await repo.listRecords({
        startDay,
        endDay,
        category: this.data.filter || undefined,
        limit: 20
      });
      const list = (res && res.list) || [];
      this.setData({
        loading: false,
        total: list.length,
        groups: this.groupRecords(list),
        hasMore: !!res.hasMore,
        cursor: res.nextCursor || null,
        isEmpty: list.length === 0
      });
    } catch (err) {
      this.setData({ loading: false });
      feedback.fail(err, '时间线没加载出来');
    }
  },

  async loadMore() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.setData({ loadingMore: true });

    const { startDay, endDay } = this.getRange();
    try {
      const res = await repo.listRecords({
        startDay,
        endDay,
        category: this.data.filter || undefined,
        cursor: this.data.cursor,
        limit: 20
      });
      const list = (res && res.list) || [];
      // 跨页合并：同一天的记录要并到同一个分组里，不能出现两个「11月2日」
      const merged = this.mergeGroups(this.data.groups, this.groupRecords(list));
      this.setData({
        groups: merged,
        hasMore: !!res.hasMore,
        cursor: res.nextCursor || null,
        loadingMore: false
      });
    } catch (err) {
      this.setData({ loadingMore: false });
      feedback.fail(err, '加载更多失败');
    }
  },

  buildRangeText(startDay, endDay) {
    const mode = this.data.mode;
    if (mode === 'day') return '只看今天';
    const days = MODES.find(m => m.key === mode).days;
    return `最近 ${days} 天`;
  },

  /** [{dayKey,label,weekday,count,items}] */
  groupRecords(list) {
    return dateUtil.groupByDay(list);
  },

  mergeGroups(oldGroups, newGroups) {
    const groups = oldGroups.slice();
    // 按 _id 去重兜底：游标是 (日期, 创建时间)，理论上跨端同毫秒写入会造成边界重复，
    // 服务端已用单调时间戳消除大部分情况，这里再兜一层——宁可重复一条也不能漏
    const seen = new Set();
    groups.forEach(g => g.items.forEach(r => seen.add(r._id)));

    newGroups.forEach(ng => {
      const fresh = ng.items.filter(r => !seen.has(r._id));
      fresh.forEach(r => seen.add(r._id));
      if (!fresh.length) return;

      const hit = groups.find(g => g.dayKey === ng.dayKey);
      if (hit) {
        hit.items = hit.items.concat(fresh);
        hit.count = hit.items.length;
      } else {
        groups.push(Object.assign({}, ng, { items: fresh, count: fresh.length }));
      }
    });
    return groups;
  },

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */
  onModeTap(e) {
    const mode = e.currentTarget.dataset.key;
    if (mode === this.data.mode) return;
    this.setData({ mode }, () => this.load(true));
  },

  onFilterTap(e) {
    const filter = e.currentTarget.dataset.key;
    if (filter === this.data.filter) return;
    this.setData({ filter }, () => this.load(true));
  },

  onRecordTap(e) {
    const id = e.detail.id;
    if (!id) return;
    wx.navigateTo({ url: `/pkgA/detail/detail?id=${id}` });
  },

  goRecord() {
    wx.navigateTo({ url: '/pages/record/record' });
  }
});
