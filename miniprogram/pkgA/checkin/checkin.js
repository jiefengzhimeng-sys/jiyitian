/**
 * 打卡激励（M5）
 * 展示层做三件事：点阵月历、连续天数、徽章墙
 * streak 的真源是「有记录的天数连续段」，由仓储层算（云端在定时任务里预计算）
 */
const repo = require('../../services/index');
const dateUtil = require('../../utils/date');
const feedback = require('../../utils/feedback');

Page({
  data: {
    loading: true,
    streak: 0,
    longest: 0,
    monthCount: 0,
    monthLabel: '',
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    cells: [],
    badges: [],
    unlockedCount: 0,
    progress: 0, // 本周完成度
    weekDone: 0
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const checkin = await repo.getCheckin();
      const checked = checkin.checkedDays || [];
      const monthCells = this.buildCalendar(checked);

      const badges = checkin.badges || [];
      const unlockedCount = badges.filter(b => b.unlocked).length;

      // 本周完成度：周一到今天，有几天记了
      const today = new Date();
      const dayOfWeek = (today.getDay() || 7) - 1; // 周一 = 0
      const weekDays = [];
      for (let i = 0; i <= dayOfWeek; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - (dayOfWeek - i));
        weekDays.push(dateUtil.toDayKey(d));
      }
      const weekDone = weekDays.filter(d => checked.indexOf(d) >= 0).length;

      this.setData({
        loading: false,
        streak: checkin.streak || 0,
        longest: checkin.longest || 0,
        monthCount: checkin.monthCount || 0,
        monthLabel: dateUtil.toMonthKey(new Date()).replace('-', ' 年 ') + ' 月',
        cells: monthCells,
        badges,
        unlockedCount,
        weekDone,
        progress: Math.round((weekDone / 7) * 100)
      });
    } catch (err) {
      this.setData({ loading: false });
      feedback.fail(err, '打卡数据没加载出来');
    }
  },

  /** 生成点阵月历：首行补空位对齐周一 */
  buildCalendar(checked) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const first = new Date(year, month, 1);
    // 周一为 0，周日为 6
    const offset = (first.getDay() || 7) - 1;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayKey = dateUtil.todayKey();

    const cells = [];
    for (let i = 0; i < offset; i++) {
      cells.push({ key: 'blank-' + i, blank: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dayKey = `${year}-${dateUtil.pad(month + 1)}-${dateUtil.pad(d)}`;
      cells.push({
        key: dayKey,
        day: d,
        checked: checked.indexOf(dayKey) >= 0,
        today: dayKey === todayKey,
        future: dayKey > todayKey
      });
    }
    return cells;
  },

  goRecord() {
    wx.navigateTo({ url: '/pages/record/record' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});
