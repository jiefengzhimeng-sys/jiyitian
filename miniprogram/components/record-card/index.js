const { findCategory, findMood, RECORD_TYPES } = require('../../utils/constants');
const dateUtil = require('../../utils/date');

Component({
  properties: {
    record: { type: Object, value: null },
    /** feed: 首页紧凑样式；timeline: 时间线带左侧色条 */
    mode: { type: String, value: 'feed' },
    /** 时间线里显示左侧色条 */
    showBar: { type: Boolean, value: false }
  },

  data: {
    catName: '',
    catColor: '#B9A7FF',
    catWash: '#F0EBFF',
    emoji: '✨',
    moodEmoji: '',
    moodName: '',
    timeText: '',
    typeName: '',
    title: '',
    thumbs: [],
    isVoice: false,
    duration: 0,
    waveHeights: [5, 9, 6, 11, 4, 8, 10, 6]
  },

  observers: {
    record(r) {
      if (!r) return;
      const cat = findCategory(r.category);
      const mood = findMood(r.mood);
      const rawThumbs = (r.thumbs && r.thumbs.length ? r.thumbs : r.images) || [];
      const thumbs = rawThumbs.slice(0, 3).map(v => ({
        isColor: typeof v === 'string' && v.indexOf('#') === 0,
        value: v
      }));

      let title = r.content || '';
      if (!title) {
        if (r.type === 'weight' && r.weight != null) title = `体重 ${r.weight} kg`;
        else if (r.type === 'voice') title = '一段语音随笔';
        else if (r.type === 'image') title = '一组照片';
        else title = '（无文字）';
      }

      this.setData({
        catName: cat.name,
        catColor: cat.color,
        catWash: cat.wash,
        emoji: r.type === 'weight' ? '⚖️' : cat.emoji,
        moodEmoji: mood ? mood.emoji : '',
        moodName: mood ? mood.name : '',
        timeText: dateUtil.toFriendlyTime(r.createdAt),
        typeName: (RECORD_TYPES[r.type] || RECORD_TYPES.text).name,
        title,
        thumbs,
        isVoice: r.type === 'voice',
        duration: (r.voice && r.voice.duration) || 0
      });
    }
  },

  methods: {
    onTap() {
      const r = this.data.record;
      if (!r) return;
      this.triggerEvent('recordtap', { id: r._id }); // 不叫 tap，避免与原生冒泡事件同名
    }
  }
});
