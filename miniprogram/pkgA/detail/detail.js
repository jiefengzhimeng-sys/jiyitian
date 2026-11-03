/**
 * 记录详情（M3）
 * 图片三级规格在这里体现：页面内联用 thumb（快），点击预览用 origin（清晰）
 */
const app = getApp();
const repo = require('../../services/index');
const media = require('../../services/media');
const dateUtil = require('../../utils/date');
const { findCategory, findMood, RECORD_TYPES } = require('../../utils/constants');
const feedback = require('../../utils/feedback');
const config = require('../../utils/config');

Page({
  data: {
    id: '',
    loading: true,
    missing: false,

    record: null,
    catName: '',
    catColor: '',
    catWash: '',
    catEmoji: '',
    moodName: '',
    moodEmoji: '',
    moodColor: '',
    typeName: '',
    timeText: '',
    dayText: '',
    weekText: '',

    thumbs: [], // 展示用（thumb）
    origins: [], // 预览用（origin）
    voiceUrl: '',
    playing: false,
    weightText: ''
  },

  onLoad(query) {
    const id = (query && query.id) || '';
    if (!id) {
      this.setData({ loading: false, missing: true });
      return;
    }
    this.setData({ id });
    this.load(id);
  },

  onUnload() {
    if (this._audio) {
      this._audio.stop();
      this._audio.destroy();
      this._audio = null;
    }
  },

  async load(id) {
    try {
      const r = await repo.getRecord(id);
      if (!r) {
        this.setData({ loading: false, missing: true });
        return;
      }

      const cat = findCategory(r.category);
      const mood = findMood(r.mood);

      // 云端存的是 fileID，展示前需换成临时链接；Mock 直接是本地路径
      const rawThumbs = r.thumbs && r.thumbs.length ? r.thumbs : r.images || [];
      const rawOrigins = r.images && r.images.length ? r.images : rawThumbs;

      let thumbs = rawThumbs;
      let origins = rawOrigins;
      let voiceUrl = (r.voice && r.voice.fileID) || '';

      if (!config.USE_MOCK && wx.cloud) {
        const map = await media.resolveTempURL([].concat(rawThumbs, rawOrigins, voiceUrl));
        thumbs = rawThumbs.map(v => map[v] || v);
        origins = rawOrigins.map(v => map[v] || v);
        voiceUrl = map[voiceUrl] || voiceUrl;
      }

      this.setData({
        loading: false,
        record: r,
        catName: cat.name,
        catColor: cat.color,
        catWash: cat.wash,
        catEmoji: r.type === 'weight' ? '⚖️' : cat.emoji,
        moodName: mood ? mood.name : '',
        moodEmoji: mood ? mood.emoji : '',
        moodColor: mood ? mood.color : '',
        typeName: (RECORD_TYPES[r.type] || RECORD_TYPES.text).name,
        timeText: dateUtil.toTime(r.createdAt),
        dayText: dateUtil.dayLabel(r.dayKey),
        weekText: dateUtil.weekday(r.dayKey),
        weightText: r.weight !== null && r.weight !== undefined ? Number(r.weight).toFixed(1) : '',
        thumbs,
        origins,
        voiceUrl
      });
    } catch (err) {
      this.setData({ loading: false, missing: true });
      feedback.fail(err, '这条记录打不开了');
    }
  },

  /** 缩略图 → 原图：内联看 thumb，点开才加载 origin */
  onPreview(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const urls = this.data.origins.length ? this.data.origins : this.data.thumbs;
    if (!urls.length) return;
    wx.previewImage({ current: urls[idx] || urls[0], urls });
  },

  onPlayVoice() {
    const src = this.data.voiceUrl;
    if (!src) {
      feedback.toast('这段语音已失效');
      return;
    }
    if (this.data.playing) {
      this._audio && this._audio.stop();
      this.setData({ playing: false });
      return;
    }
    const audio = wx.createInnerAudioContext();
    this._audio = audio;
    audio.src = src;
    audio.onEnded(() => {
      this.setData({ playing: false });
      audio.destroy();
      this._audio = null;
    });
    audio.onError(() => {
      this.setData({ playing: false });
      audio.destroy();
      this._audio = null;
      feedback.toast('语音播放失败');
    });
    audio.play();
    this.setData({ playing: true });
  },

  async onDelete() {
    const yes = await feedback.confirm('删除后不可恢复（云端会保留 30 天回收站）。确定删掉这条？', '删除记录');
    if (!yes) return;
    feedback.loading('删除中');
    try {
      await repo.removeRecord(this.data.id);
      feedback.hideLoading();
      app.globalData.needRefresh = true;
      feedback.ok('已删除');
      setTimeout(() => wx.navigateBack(), 600);
    } catch (err) {
      feedback.hideLoading();
      feedback.fail(err, '删除没成功');
    }
  },

  onBack() {
    wx.navigateBack();
  },

  goRecord() {
    wx.navigateTo({ url: '/pages/record/record' });
  }
});
