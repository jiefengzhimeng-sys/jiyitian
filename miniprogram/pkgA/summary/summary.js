/**
 * AI 总结（M10）
 * 三级总结共用一套版式：刊头（type + period）→ 大标题 → 三段块 → 曲线 → 免责声明
 * 生成策略：优先读已生成结果；无结果时用户可手动生成；云端由定时任务在周期末预生成
 */
const repo = require('../../services/index');
const dateUtil = require('../../utils/date');
const feedback = require('../../utils/feedback');

const TYPES = [
  { key: 'day', name: '日总结', days: 1, kicker: 'DAILY' },
  { key: 'week', name: '周总结', days: 7, kicker: 'WEEKLY' },
  { key: 'month', name: '月总结', days: 30, kicker: 'MONTHLY' }
];

Page({
  data: {
    types: TYPES,
    type: 'week',
    kicker: 'WEEKLY',
    periodText: '',

    loading: true,
    generating: false,
    summary: null,
    empty: false, // 这个周期还没生成过（云端定时任务是周期末预生成，用户可能先到）
    blocks: [],
    tags: [],

    // 曲线
    hasWeight: false,
    weightSeries: [],

    // 数据不足（< 3 条）
    tooFew: false,
    recordCount: 0
  },

  onLoad(query) {
    const type = (query && query.type) || 'week';
    const hit = TYPES.some(t => t.key === type) ? type : 'week';
    this.setData({ type: hit, kicker: TYPES.find(t => t.key === hit).kicker });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    const t = TYPES.find(x => x.key === this.data.type);
    // 周期口径必须跟云函数 periodRange 一致：日=当天、周=本周一至周日、月=自然月。
    // 早先用「近 7 天 / 近 30 天」，跨周跨月时正文说的周期和曲线画的区间不是同一段。
    const range = dateUtil.periodRange(this.data.type);
    const startDay = range.startKey;
    const endDay = range.endKey;

    this.setData({
      loading: true,
      periodText: this.buildPeriod(startDay, endDay, this.data.type)
    });

    try {
      const [summary, stats] = await Promise.all([
        repo.getSummary({ type: this.data.type }),
        repo.getStats({ startDay, endDay })
      ]);

      const weightSeries = (stats.weightSeries || []).map(p => ({
        label: p.dayKey.slice(5),
        value: p.value
      }));

      this.setData({
        loading: false,
        summary: summary || null,
        empty: !summary,
        blocks: (summary && summary.blocks) || [],
        tags: (summary && summary.tags) || [],
        hasWeight: weightSeries.length >= 2,
        weightSeries,
        recordCount: stats.totalRecords || 0,
        tooFew: (stats.totalRecords || 0) < 3
      });
    } catch (err) {
      this.setData({ loading: false });
      feedback.fail(err, '总结没读出来');
    }
  },

  /** 刊头日期：11.02 / 10.27 — 11.02 / 2026 年 10 月 */
  buildPeriod(startDay, endDay, type) {
    if (type === 'day') {
      const d = new Date(endDay.replace(/-/g, '/'));
      return `${d.getMonth() + 1}.${d.getDate()}`;
    }
    if (type === 'month') return endDay.slice(0, 4) + ' 年 ' + Number(endDay.slice(5, 7)) + ' 月';
    return `${startDay.slice(5).replace('-', '.')} — ${endDay.slice(5).replace('-', '.')}`;
  },

  onTypeTap(e) {
    const type = e.currentTarget.dataset.key;
    if (type === this.data.type) return;
    const hit = TYPES.find(t => t.key === type);
    this.setData({ type, kicker: hit.kicker }, () => this.load());
  },

  async onGenerate() {
    if (this.data.generating) return;
    if (this.data.tooFew) {
      feedback.toast('记录少于 3 条，多记几天再来');
      return;
    }
    this.setData({ generating: true });
    feedback.loading('AI 正在读你的记录');
    try {
      await repo.generateSummary({ type: this.data.type });
      feedback.hideLoading();
      feedback.ok('生成好了');
      await this.load();
    } catch (err) {
      feedback.hideLoading();
      feedback.fail(err, '生成没成功，稍后重试');
    } finally {
      this.setData({ generating: false });
    }
  },

  goRecord() {
    wx.navigateTo({ url: '/pages/record/record' });
  },

  goStats() {
    wx.switchTab({ url: '/pages/stats/stats' });
  }
});
