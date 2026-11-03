Component({
  properties: {
    emoji: { type: String, value: '🌱' },
    title: { type: String, value: '这里还是空的' },
    desc: { type: String, value: '' },
    btnText: { type: String, value: '' },
    /** 提示卡片文案，可为空 */
    tip: { type: String, value: '' }
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    }
  }
});
