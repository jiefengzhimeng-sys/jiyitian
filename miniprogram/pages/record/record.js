/**
 * 记录创建页（M2）
 * 三种输入形态：文字 / 语音 / 图片，共享分类、情绪、体重
 * 设计要点：
 *  1. 草稿自动存本地（断网/误退不丢），进入页面时静默恢复
 *  2. 语音长按录制、上滑取消、60 秒自动停止（RecorderManager 全局单例，onUnload 必须解绑）
 *  3. 图片压缩两道：chooseMedia 已压缩 + normalize 长边 2000 兜底
 *  4. 保存成功后置 needRefresh，回首页只请求一次（避免 onShow 重复请求，见 E-07）
 */
const app = getApp();
const repo = require('../../services/index');
const media = require('../../services/media');
const dateUtil = require('../../utils/date');
const { CATEGORIES } = require('../../utils/constants');
const feedback = require('../../utils/feedback');
const config = require('../../utils/config');

const K_DRAFT = 'jy_draft_v1';
const INPUT_TABS = [
  { key: 'text', name: '文字', emoji: '✍️' },
  { key: 'voice', name: '语音', emoji: '🎙️' },
  { key: 'image', name: '图片', emoji: '📷' }
];
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

Page({
  data: {
    inputTabs: INPUT_TABS,
    tab: 'text',

    categories: CATEGORIES,
    category: 'sport',

    content: '',
    maxLen: config.MAX_TEXT_LEN,

    mood: '',

    images: [], // [{ path, isColor:false }]
    maxImages: config.MAX_IMAGES,
    uploading: false,

    weightOpen: false,
    weight: '',
    weightMin: config.WEIGHT_MIN,
    weightMax: config.WEIGHT_MAX,

    // 语音
    recording: false,
    willCancel: false,
    recordSec: 0,
    voice: null, // { path, duration }
    playing: false,

    saving: false,
    draftRestored: false,
    dateText: ''
  },

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */
  onLoad(query) {
    const now = new Date();
    this.setData({
      dateText: `${now.getMonth() + 1}月${now.getDate()}日 周${WEEK_CN[now.getDay()]}`
    });

    // 先恢复草稿，再让入口参数覆盖。
    // 顺序不能反：草稿里有上次的 category/tab，若最后恢复就会把「首页点了运动」
    // 改成上次记的「饮食 + 图片」，用户看到的是另一张表单（联调实测踩到）。
    this.restoreDraft();
    this.applyEntry(query);

    this.initRecorder();
  },

  /**
   * 入口参数：首页快捷入口 / 时间线按钮带过来的「我这次想记什么」
   * 入口是用户当下的选择，优先级高于草稿里的历史选择
   */
  applyEntry(query) {
    if (!query) return;
    const patch = {};
    if (query.category && CATEGORIES.some(c => c.key === query.category)) {
      patch.category = query.category;
    }
    if (query.tab && ['text', 'voice', 'image'].indexOf(query.tab) >= 0) {
      patch.tab = query.tab;
    }
    if (query.focus === 'weight') {
      patch.tab = 'text';
      patch.weightOpen = true;
    }
    if (Object.keys(patch).length) this.setData(patch);
  },

  onUnload() {
    // 定时器与录音监听必须清理，否则反复进出会内存泄漏（见 E-09）
    this.clearRecordTimer();
    if (this.recorder) {
      this.recorder.onStop(() => {});
      this.recorder.onError(() => {});
      this.recorder.onStart(() => {});
      this.recorder.onTimeUpdate(() => {});
    }
    if (this.data.recording) {
      try { this.recorder && this.recorder.stop(); } catch (e) {}
    }
    this.flushDraft();
  },

  onHide() {
    this.flushDraft();
  },

  /* ------------------------------------------------------------------ */
  /* 草稿                                                                */
  /* ------------------------------------------------------------------ */
  restoreDraft() {
    const draft = wx.getStorageSync(K_DRAFT);
    if (!draft || !draft.savedAt) return;
    // 超过 24 小时的草稿不再恢复，避免突然冒出旧内容
    if (Date.now() - draft.savedAt > 86400000) {
      wx.removeStorageSync(K_DRAFT);
      return;
    }
    const hasSomething =
      (draft.content && draft.content.trim()) || (draft.images || []).length || draft.weight;
    if (!hasSomething) return;

    this.setData({
      content: draft.content || '',
      category: draft.category || 'sport',
      mood: draft.mood || '',
      images: draft.images || [],
      weight: draft.weight || '',
      weightOpen: !!draft.weight,
      tab: draft.tab || 'text',
      draftRestored: true
    });
  },

  saveDraft() {
    const d = this.data;
    const payload = {
      content: d.content,
      category: d.category,
      mood: d.mood,
      images: d.images,
      weight: d.weight,
      tab: d.tab,
      savedAt: Date.now()
    };
    try {
      wx.setStorageSync(K_DRAFT, payload);
    } catch (e) {
      // 存储满了也不该阻塞用户记录
      console.warn('[记一天] 草稿保存失败', e);
    }
  },

  /** 输入过程中防抖存草稿，避免每次按键都写 Storage */
  queueDraft() {
    if (this._draftTimer) clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => this.saveDraft(), 600);
  },

  flushDraft() {
    if (this._draftTimer) {
      clearTimeout(this._draftTimer);
      this._draftTimer = null;
    }
    this.saveDraft();
  },

  clearDraft() {
    wx.removeStorageSync(K_DRAFT);
    this.setData({ draftRestored: false });
  },

  onDiscardDraft() {
    feedback.confirm('当前内容会被清空，确定丢掉吗？', '清空草稿').then(yes => {
      if (!yes) return;
      wx.removeStorageSync(K_DRAFT);
      this.setData({
        content: '',
        mood: '',
        images: [],
        weight: '',
        weightOpen: false,
        voice: null,
        recordSec: 0,
        draftRestored: false,
        tab: 'text'
      });
    });
  },

  /* ------------------------------------------------------------------ */
  /* 基础输入                                                            */
  /* ------------------------------------------------------------------ */
  onTabChange(e) {
    const tab = e.currentTarget.dataset.key;
    this.setData({ tab });
    this.queueDraft();
  },

  onCategoryTap(e) {
    this.setData({ category: e.currentTarget.dataset.key });
    this.queueDraft();
  },

  onInput(e) {
    this.setData({ content: e.detail.value });
    this.queueDraft();
  },

  onMoodChange(e) {
    this.setData({ mood: e.detail.value });
    this.queueDraft();
  },

  toggleWeight() {
    this.setData({ weightOpen: !this.data.weightOpen });
  },

  onWeightInput(e) {
    this.setData({ weight: e.detail.value });
    this.queueDraft();
  },

  /** 步进器：±0.1kg，边界内收敛 */
  stepWeight(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const base = parseFloat(this.data.weight) || 60;
    let next = +(base + delta).toFixed(1);
    if (next < config.WEIGHT_MIN) next = config.WEIGHT_MIN;
    if (next > config.WEIGHT_MAX) next = config.WEIGHT_MAX;
    this.setData({ weight: String(next) });
    this.queueDraft();
  },

  /** 拿最近一次体重做默认值，少打几个字 */
  async prefillWeight() {
    if (this.data.weight) return;
    try {
      const today = dateUtil.todayKey();
      const res = await repo.getStats({ startDay: dateUtil.recentDays(30, today)[0], endDay: today });
      if (res && res.weightCurrent) this.setData({ weight: String(res.weightCurrent) });
    } catch (e) {
      // 预填失败无所谓，不打扰用户
    }
  },

  /* ------------------------------------------------------------------ */
  /* 图片                                                                */
  /* ------------------------------------------------------------------ */
  async chooseImages() {
    // 相册/相机属隐私接口，先走标准授权，未同意就不继续
    const allowed = await app.requirePrivacy();
    if (!allowed) return;

    const left = this.data.maxImages - this.data.images.length;
    if (left <= 0) {
      feedback.toast(`最多 ${this.data.maxImages} 张`);
      return;
    }
    if (!wx.chooseMedia) {
      feedback.toast('当前微信版本不支持选图，请升级微信');
      return;
    }
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'], // 第一道压缩：系统侧
      sourceType: ['album', 'camera'],
      success: async res => {
        const files = (res.tempFiles || []).map(f => f.tempFilePath);
        if (!files.length) return;
        this.setData({ uploading: true });
        try {
          // 第二道压缩：长边 >2000 再压一次，避免几十 MB 原图直接进列表
          const normalized = await Promise.all(files.map(f => media.normalize(f)));
          const next = this.data.images.concat(
            normalized.map(p => ({ path: p, isColor: false }))
          );
          this.setData({ images: next });
          this.queueDraft();
        } catch (err) {
          feedback.fail(err, '图片处理失败，换一张试试');
        } finally {
          this.setData({ uploading: false });
        }
      },
      fail: err => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        feedback.fail(err, '没打开相册');
      }
    });
  },

  onPreviewImage(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const urls = this.data.images.map(i => i.path);
    wx.previewImage({ current: urls[idx], urls });
  },

  onRemoveImage(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    images.splice(idx, 1);
    this.setData({ images });
    this.queueDraft();
  },

  /* ------------------------------------------------------------------ */
  /* 语音                                                                */
  /* ------------------------------------------------------------------ */
  initRecorder() {
    if (!wx.getRecorderManager) return;
    this.recorder = wx.getRecorderManager();

    this.recorder.onStart(() => {
      this.setData({ recording: true, willCancel: false, recordSec: 0 });
      this.startRecordTimer();
    });

    this.recorder.onStop(res => {
      this.clearRecordTimer();
      const willCancel = this.data.willCancel;
      this.setData({ recording: false, willCancel: false });

      if (willCancel) {
        this.setData({ recordSec: 0 });
        return;
      }
      if (!res || !res.tempFilePath) {
        this.setData({ recordSec: 0 });
        feedback.toast('没录上，再试一次');
        return;
      }
      if (res.duration < 1000) {
        this.setData({ recordSec: 0 });
        feedback.toast('太短了，说话再久一点点');
        return;
      }
      this.setData({
        voice: { path: res.tempFilePath, duration: Math.round(res.duration / 1000) },
        recordSec: Math.round(res.duration / 1000)
      });
      this.queueDraft();
    });

    this.recorder.onError(err => {
      this.clearRecordTimer();
      this.setData({ recording: false, willCancel: false, recordSec: 0 });
      console.error('[记一天] 录音失败', err);
      feedback.toast('录音没成功，检查一下麦克风权限');
    });
  },

  startRecordTimer() {
    this.clearRecordTimer();
    this._recordTimer = setInterval(() => {
      const next = this.data.recordSec + 1;
      this.setData({ recordSec: next });
      if (next >= config.MAX_VOICE_MS / 1000) {
        // 到 60 秒自动收尾（RecorderManager 自身也会停，这里兜一层）
        try { this.recorder.stop(); } catch (e) {}
      }
    }, 1000);
  },

  clearRecordTimer() {
    if (this._recordTimer) {
      clearInterval(this._recordTimer);
      this._recordTimer = null;
    }
  },

  onVoiceStart() {
    if (!this.recorder) {
      feedback.toast('当前微信版本不支持录音');
      return;
    }
    if (this.data.voice) {
      feedback.confirm('要重新录一段吗？已有录音会被替换').then(yes => {
        if (yes) {
          this.setData({ voice: null, recordSec: 0 });
          this.startRecord();
        }
      });
      return;
    }
    this.startRecord();
  },

  async startRecord() {
    const allowed = await app.requirePrivacy();
    if (!allowed) return;
    this.recorder.start({
      duration: config.MAX_VOICE_MS,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    });
  },

  /** 手指上移超过阈值 = 取消（与 UI 稿的交互一致） */
  onVoiceMove(e) {
    if (!this.data.recording) return;
    const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!touch) return;
    const startY = this._startY || touch.clientY;
    if (!this._startY) this._startY = touch.clientY;
    const willCancel = startY - touch.clientY > 60;
    if (willCancel !== this.data.willCancel) this.setData({ willCancel });
  },

  onVoiceEnd() {
    this._startY = null;
    if (!this.data.recording) return;
    try { this.recorder.stop(); } catch (e) {}
  },

  onPlayVoice() {
    if (!this.data.voice) return;
    if (this.data.playing) {
      wx.stopBackgroundAudio && wx.stopBackgroundAudio();
      this.setData({ playing: false });
      return;
    }
    const audio = wx.createInnerAudioContext();
    audio.src = this.data.voice.path;
    audio.onEnded(() => {
      this.setData({ playing: false });
      audio.destroy();
    });
    audio.onError(() => {
      this.setData({ playing: false });
      audio.destroy();
      feedback.toast('播放失败');
    });
    audio.play();
    this.setData({ playing: true });
  },

  onRemoveVoice() {
    this.setData({ voice: null, recordSec: 0, playing: false });
    this.queueDraft();
  },

  /* ------------------------------------------------------------------ */
  /* 保存                                                                */
  /* ------------------------------------------------------------------ */
  validate() {
    const d = this.data;
    const hasText = !!(d.content && d.content.trim());
    const hasImages = d.images.length > 0;
    const hasVoice = !!d.voice;
    const w = d.weight === '' ? null : Number(d.weight);

    if (w !== null) {
      if (isNaN(w) || w < config.WEIGHT_MIN || w > config.WEIGHT_MAX) {
        return { ok: false, msg: `体重填 ${config.WEIGHT_MIN}-${config.WEIGHT_MAX} 公斤之间哦` };
      }
    }
    if (!hasText && !hasImages && !hasVoice && w === null) {
      return { ok: false, msg: '写点什么再保存吧' };
    }
    if (d.tab === 'voice' && !hasVoice) {
      return { ok: false, msg: '按住按钮说两句，就是一条语音记录' };
    }
    if (d.tab === 'image' && !hasImages) {
      return { ok: false, msg: '选一张照片吧' };
    }
    return { ok: true, weight: w };
  },

  async onSubmit() {
    if (this.data.saving) return;
    const check = this.validate();
    if (!check.ok) {
      feedback.toast(check.msg);
      return;
    }

    const d = this.data;
    this.setData({ saving: true });
    feedback.loading('保存中');

    try {
      const openid = (app.globalData && app.globalData.openid) || 'local';
      let images = [];
      let thumbs = [];

      // 真实环境下先把图片/语音传到云存储，再落记录
      if (d.images.length) {
        const uploaded = await Promise.all(d.images.map(i => media.uploadImage(i.path, openid)));
        images = uploaded.map(u => u.originFileID);
        // 落库存 fileID，不能存 getTempFileURL 出来的 https 链接：
        // 临时链接 2 小时就失效，而记录是长期数据，列表缩略图会成片裂图。
        // image 组件本身支持直连 cloud:// fileID（需要临时链接的场景只有详情预览）。
        thumbs = uploaded.map(u => u.thumbFileID);
      }

      let voice = null;
      if (d.voice) {
        const v = await media.uploadVoice(d.voice.path, openid, d.voice.duration);
        voice = { fileID: v.fileID, duration: v.duration };
      }

      const type = this.resolveType(check.weight);
      const payload = {
        type,
        category: d.category,
        content: (d.content || '').trim(),
        mood: d.mood || '',
        weight: check.weight,
        images,
        thumbs,
        voice,
        dayKey: dateUtil.todayKey(),
        createdAt: Date.now()
      };

      await repo.createRecord(payload);

      wx.removeStorageSync(K_DRAFT);
      app.globalData.needRefresh = true;
      feedback.hideLoading();
      feedback.ok('记下了');

      setTimeout(() => {
        const pages = getCurrentPages();
        if (pages.length > 1) wx.navigateBack();
        else wx.switchTab({ url: '/pages/home/home' });
      }, 700);
    } catch (err) {
      feedback.hideLoading();
      this.setData({ saving: false });
      feedback.fail(err, '没保存成功，内容还在，再试一次');
    }
  },

  /** 只有体重没有其他内容时，类型记为 weight，时间线/统计才能正确归类 */
  resolveType(weight) {
    const d = this.data;
    if (weight !== null && !(d.content || '').trim() && !d.images.length && !d.voice) return 'weight';
    if (d.voice) return 'voice';
    if (d.images.length) return 'image';
    return 'text';
  }
});
