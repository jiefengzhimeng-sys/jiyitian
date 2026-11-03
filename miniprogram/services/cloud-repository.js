/**
 * 云端仓储：所有数据读写走单一云函数 api（action 路由）
 * 与 mock-repository 实现完全相同的契约，业务层零感知
 */
const config = require('../utils/config');

function call(action, payload) {
  return wx.cloud
    .callFunction({ name: config.API_FN, data: { action, payload: payload || {} } })
    .then(res => {
      const body = res && res.result;
      if (!body) {
        const e = new Error('EMPTY_RESULT');
        e.friendly = '服务没有响应，稍后再试';
        throw e;
      }
      if (body.code !== 0) {
        const e = new Error(body.message || 'BIZ_ERROR');
        e.friendly = body.message || '操作没成功，稍后再试';
        e.code = body.code;
        throw e;
      }
      return body.data;
    })
    .catch(err => {
      if (err && err.friendly) throw err;
      const e = new Error((err && err.errMsg) || 'NETWORK_ERROR');
      e.friendly = '网络不太好，检查一下再试';
      throw e;
    });
}

module.exports = {
  name: 'cloud',

  userInit() {
    return call('user.init');
  },

  listRecords(query) {
    return call('record.list', query);
  },

  getRecord(id) {
    return call('record.get', { id });
  },

  createRecord(payload) {
    return call('record.create', payload);
  },

  removeRecord(id) {
    return call('record.remove', { id });
  },

  getToday() {
    return call('record.today');
  },

  getStats(range) {
    return call('stats.overview', range);
  },

  getCheckin() {
    return call('checkin.get');
  },

  getProfile() {
    return call('profile.get');
  },

  updateProfile(patch) {
    return call('profile.update', patch);
  },

  getSummary(params) {
    return call('summary.get', params);
  },

  generateSummary(params) {
    return call('summary.generate', params);
  }
};
