const { MOODS } = require('../../utils/constants');

Component({
  properties: {
    value: { type: String, value: '' },
    /** 是否允许再次点击取消选中 */
    clearable: { type: Boolean, value: true }
  },

  data: {
    moods: MOODS
  },

  methods: {
    onPick(e) {
      const key = e.currentTarget.dataset.key;
      const next = this.data.clearable && key === this.data.value ? '' : key;
      this.triggerEvent('change', { value: next });
    }
  }
});
