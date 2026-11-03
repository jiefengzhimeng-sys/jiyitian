/**
 * 数据页（M7）
 * 三条曲线：体重（折线，主）、情绪分布（环形）、饮食频次（柱状）
 * 数据层已做聚合（mock 里是 computeStats，云端读 daily_aggs + user_stats），
 * 页面只负责把聚合结果翻译成图表能吃的 series
 */
const repo = require('../../services/index');
const dateUtil = require('../../utils/date');
const { findMood } = require('../../utils/constants');
const feedback = require('../../utils/feedback');

const RANGES = [
  { key: 'week', name: '近 7 天', days: 7 },
  { key: 'month', name: '近 30 天', days: 30 },
  { key: 'quarter', name: '近 90 天', days: 90 }
];

Page({
  data: {
    ranges: RANGES,
    range: 'week',
    rangeText: '',

    loading: true,
    empty: false,

    // 概览
    totalRecords: 0,
    sportDays: 0,
    dietCount: 0,
    streak: 0,

    // 体重
    weightSeries: [],
    weightCur: '--',
    weightDelta: null,
    weightDeltaText: '',
    weightTrend: 'flat', // up / down / flat
    hasWeight: false,

    // 情绪
    hasMood: false,
    moodSegments: [],
    moodDist: [],
    moodTopText: '',
    moodTopEmoji: '',

    // 饮食
    dietSeries: [],
    dietLabels: []
  },

  onLoad() {
    this.load();
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 3 });

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
    const range = RANGES.find(r => r.key === this.data.range) || RANGES[0];
    const endDay = dateUtil.todayKey();
    const days = dateUtil.recentDays(range.days, endDay);
    const startDay = days[0];

    this.setData({ loading: true, rangeText: `${days.length} 天` });

    try {
      const [stats, checkin] = await Promise.all([
        repo.getStats({ startDay, endDay }),
        repo.getCheckin()
      ]);

      this.setData(Object.assign(
        {
          loading: false,
          totalRecords: stats.totalRecords || 0,
          sportDays: stats.sportDays || 0,
          dietCount: stats.dietCount || 0,
          streak: (checkin && checkin.streak) || 0,
          empty: !stats.totalRecords
        },
        this.buildWeight(stats, days),
        this.buildMood(stats),
        this.buildDiet(stats, days)
      ));
    } catch (err) {
      this.setData({ loading: false });
      feedback.fail(err, '数据没算出来');
    }
  },

  /* ------------------------------------------------------------------ */
  /* 图表数据构造                                                        */
  /* ------------------------------------------------------------------ */

  /** 体重：按天取最后一次记录，缺测的那天不连线（用 null 桥接会产生断点，这里直接跳过） */
  buildWeight(stats, days) {
    const series = (stats.weightSeries || []).map(p => ({
      label: p.dayKey.slice(5),
      value: p.value
    }));

    if (!series.length) {
      return {
        hasWeight: false,
        weightSeries: [],
        weightCur: '--',
        weightDelta: null,
        weightDeltaText: '还没有体重记录',
        weightTrend: 'flat'
      };
    }

    const cur = series[series.length - 1].value;
    const delta = stats.weightDelta;
    let trend = 'flat';
    if (delta !== null && delta !== undefined) {
      if (delta > 0.2) trend = 'up';
      else if (delta < -0.2) trend = 'down';
    }
    const deltaText =
      delta === null || delta === undefined
        ? '记录两天以上才能看到变化'
        : Math.abs(delta) < 0.05
        ? '基本没有变化'
        : `${delta > 0 ? '增加' : '减少'} ${Math.abs(delta).toFixed(1)} kg`;

    return {
      hasWeight: true,
      weightSeries: series,
      weightCur: cur.toFixed(1),
      weightDelta: delta,
      weightDeltaText: deltaText,
      weightTrend: trend
    };
  },

  /** 情绪：环形分布 + 最高频那一档 */
  buildMood(stats) {
    const dist = stats.moodDist || [];
    if (!dist.length) {
      return {
        hasMood: false,
        moodSegments: [],
        moodDist: [],
        moodTopText: '这段时间还没记心情',
        moodTopEmoji: ''
      };
    }
    // 百分比四舍五入后可能合计 102%，环形图会多画 7°；这里归一化到 100
    const raw = dist.map(d => ({ color: d.color, percent: d.percent }));
    const totalPct = raw.reduce((a, b) => a + b.percent, 0) || 100;
    const segments = raw.map(d => ({
      color: d.color,
      percent: +((d.percent * 100) / totalPct).toFixed(2)
    }));
    const top = stats.moodTop;
    const mood = top ? findMood(top.key) : null;
    return {
      hasMood: true,
      moodSegments: segments,
      moodDist: dist, // 图例直接用（含 name / percent / color / count）
      moodTopText: mood ? `出现最多的是「${mood.name}」` : '',
      moodTopEmoji: mood ? mood.emoji : ''
    };
  },

  /** 饮食：按天计数柱状；超过 14 天做抽样，避免柱子糊成一片 */
  buildDiet(stats, days) {
    const byDay = stats.dietByDay || [];
    let list = byDay;
    if (list.length > 14) {
      // 每 3 天合并一次，保持可读
      const merged = [];
      for (let i = 0; i < list.length; i += 3) {
        const chunk = list.slice(i, i + 3);
        merged.push({
          dayKey: chunk[chunk.length - 1].dayKey,
          count: chunk.reduce((s, c) => s + c.count, 0)
        });
      }
      list = merged;
    }
    return {
      dietSeries: list.map(d => ({ label: d.dayKey.slice(5), value: d.count })),
      dietLabels: list.map(d => d.dayKey)
    };
  },

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */
  onRangeTap(e) {
    const range = e.currentTarget.dataset.key;
    if (range === this.data.range) return;
    this.setData({ range }, () => this.load());
  },

  goRecord() {
    wx.navigateTo({ url: '/pages/record/record?tab=text&focus=weight' });
  },

  goSummary() {
    wx.navigateTo({ url: '/pkgA/summary/summary?type=month' });
  }
});
