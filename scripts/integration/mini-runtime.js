/**
 * 极简小程序运行时（仅用于本地联调）
 *
 * 目的：让 miniprogram 下的**真实页面代码**（pages/**.js、services/、components/）
 *      在 Node 里原样跑起来，且 wx.cloud.callFunction 直接打到云函数入口 main()。
 *      也就是说：页面 → cloud-repository → api.main → service → dao → 内存数据库，
 *      全链路都是生产代码，只有「微信客户端」和「云数据库」这两层是假的。
 *
 * 刻意不做的事：
 *   - 不解析 wxml（那是渲染层的事，联调关心数据契约）
 *   - 不实现 setData 的 diff，只做浅合并（页面逻辑不依赖渲染细节）
 *   - 不模拟网络延迟（延迟由 page 自己的 loading 态处理，不参与断言）
 */

const path = require('path');

const MP_ROOT = path.resolve(__dirname, '../../miniprogram');
const API_ROOT = path.resolve(__dirname, '../../cloudfunctions/api');

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** setData 支持 'a.b' 形式的路径，与小程序行为保持一致 */
function setByPath(obj, key, value) {
  if (key.indexOf('.') < 0) {
    obj[key] = value;
    return;
  }
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * 建一个运行时
 * @param {object} opt
 *   cloud    内存版 wx-server-sdk（见 cloudfunctions/api/scripts/memory-cloud.js）
 *   api      云函数入口模块（require('../cloudfunctions/api')）
 *   openid   当前模拟登录用户的 openid
 */
function createRuntime(opt) {
  const { cloud, api } = opt;
  const log = {
    toasts: [],      // [{title, icon}]
    nav: [],         // [{type, url}]
    requests: [],    // [{action, code, ms}]
    uploads: [],     // cloudPath
    errors: []       // 页面里 console.error 抓到的真实异常对象
  };

  const storage = new Map();
  let recorder = null;
  let currentOpenid = opt.openid || 'openid_e2e_user';

  /* ---------------- 云存储：fileID 用 cloud:// 前缀，临时链接另给一份 ---------------- */
  const fileStore = new Map(); // fileID -> { path }
  const tempURL = fileID => 'https://cdn.jiyitian.test/' + encodeURIComponent(fileID);

  const wx = {
    /* 存储 */
    getStorageSync: k => (storage.has(k) ? clone(storage.get(k)) : ''),
    setStorageSync: (k, v) => storage.set(k, clone(v)),
    removeStorageSync: k => storage.delete(k),

    /* 反馈 */
    showToast: o => log.toasts.push({ title: o && o.title, icon: (o && o.icon) || 'none' }),
    showLoading: () => {},
    hideLoading: () => {},
    showModal: o => {
      // 默认点「确定」，页面里所有 confirm 都走通
      if (o && o.success) o.success({ confirm: true, cancel: false });
    },

    /* 路由 */
    navigateTo: o => log.nav.push({ type: 'navigateTo', url: o.url }),
    switchTab: o => log.nav.push({ type: 'switchTab', url: o.url }),
    redirectTo: o => log.nav.push({ type: 'redirectTo', url: o.url }),
    navigateBack: () => log.nav.push({ type: 'navigateBack' }),
    stopPullDownRefresh: () => {},

    /* 系统信息 */
    getWindowInfo: () => ({
      statusBarHeight: 44,
      screenHeight: 812,
      windowHeight: 812,
      safeArea: { bottom: 778 }
    }),

    /* 隐私 */
    getPrivacySetting: o => o && o.success && o.success({ needAuthorization: false }),
    requirePrivacyAuthorize: o => o && o.success && o.success({}),

    /* 云开发 */
    cloud: {
      init: () => {},
      async callFunction({ name, data }) {
        const started = Date.now();
        if (name !== 'api') throw new Error('未知云函数：' + name);
        cloud.__setOpenid(currentOpenid);
        let res;
        try {
          res = await api.main(data || {});
        } catch (e) {
          log.requests.push({ action: data && data.action, code: 'THROW', ms: Date.now() - started });
          throw e;
        }
        log.requests.push({
          action: data && data.action,
          code: res && res.code,
          ms: Date.now() - started
        });
        // 小程序真实返回结构：{ result, errMsg }
        return { result: res, errMsg: 'cloud.callFunction:ok' };
      },
      async uploadFile({ cloudPath, filePath }) {
        log.uploads.push(cloudPath);
        const fileID = 'cloud://test-env.7465/' + cloudPath;
        fileStore.set(fileID, { path: filePath });
        return { fileID, statusCode: 200 };
      },
      async getTempFileURL({ fileList }) {
        return {
          fileList: (fileList || []).map(f => ({
            fileID: typeof f === 'string' ? f : f.fileID,
            tempFileURL: tempURL(typeof f === 'string' ? f : f.fileID),
            status: 0
          }))
        };
      }
    },

    /* 媒体 */
    chooseMedia: o => {
      const files = wx.__nextMedia || [];
      if (o && o.success) o.success({ tempFiles: files.map(p => ({ tempFilePath: p })) });
    },
    getImageInfo: o => o && o.success && o.success({ width: 1200, height: 900 }),
    compressImage: o => o && o.success && o.success({ tempFilePath: o.src }),
    previewImage: o => log.nav.push({ type: 'previewImage', url: o.current }),
    getRecorderManager: () => recorder,
    createInnerAudioContext: () => ({
      src: '',
      play() {},
      stop() {},
      destroy() {},
      onEnded() {},
      onError() {}
    }),
    stopBackgroundAudio: () => {}
  };

  /* ---------------- 录音管理器：由测试显式驱动 ---------------- */
  recorder = (function createRecorder() {
    const handlers = { start: [], stop: [], error: [], time: [] };
    return {
      onStart: fn => handlers.start.push(fn),
      onStop: fn => handlers.stop.push(fn),
      onError: fn => handlers.error.push(fn),
      onTimeUpdate: fn => handlers.time.push(fn),
      start() {
        wx.__recording = true;
        handlers.start.forEach(fn => fn({}));
      },
      stop() {
        if (!wx.__recording) return;
        wx.__recording = false;
        const duration = wx.__voiceDuration || 4200;
        handlers.stop.forEach(fn =>
          fn({ tempFilePath: 'wxfile://voice_' + Date.now() + '.mp3', duration })
        );
      }
    };
  })();

  /* ---------------- 运行时全局 ---------------- */
  let appInstance = null;
  const pages = [];

  global.wx = wx;
  global.getApp = () => appInstance;
  global.getCurrentPages = () => pages.slice();

  /** 启动 App（app.js 里的 onLaunch 会去调 user.init） */
  function bootstrapApp() {
    let cfg = null;
    global.App = c => {
      cfg = c;
    };
    require(path.join(MP_ROOT, 'app.js'));
    appInstance = cfg;
    global.__app = appInstance;
    if (appInstance && appInstance.onLaunch) appInstance.onLaunch();
    return appInstance;
  }

  /**
   * 载入并实例化一个页面
   * @param {string} relPath 相对 miniprogram 的路径，如 'pages/home/home.js'
   */
  function createPage(relPath) {
    const abs = path.join(MP_ROOT, relPath);
    let cfg = null;
    global.Page = c => {
      cfg = c;
    };
    global.Component = c => {
      cfg = { __component: true, config: c };
    };
    delete require.cache[require.resolve(abs)];
    require(abs);
    if (!cfg) throw new Error('页面没有调用 Page()：' + relPath);
    if (cfg.__component) throw new Error('这不是页面：' + relPath);

    const page = { __path: relPath };
    Object.keys(cfg).forEach(k => {
      page[k] = typeof cfg[k] === 'function' ? cfg[k] : clone(cfg[k]);
    });
    page.data = clone(cfg.data) || {};
    page.setData = function (patch, cb) {
      Object.keys(patch || {}).forEach(k => setByPath(page.data, k, patch[k]));
      if (typeof cb === 'function') cb();
    };
    // 自定义 tabBar 的选中态同步，联调不关心渲染，给个空壳即可
    page.getTabBar = () => ({ setData() {} });

    const originUnload = page.onUnload;
    page.onUnload = function () {
      pages.splice(pages.indexOf(page), 1);
      if (originUnload) return originUnload.call(page);
    };
    pages.push(page);
    return page;
  }

  return {
    wx,
    log,
    storage,
    MP_ROOT,
    API_ROOT,
    get app() {
      return appInstance;
    },
    setOpenid(id) {
      currentOpenid = id;
    },
    /** 下一次 chooseMedia 返回的临时文件 */
    queueMedia(paths) {
      wx.__nextMedia = paths;
    },
    /** 下一次录音时长（毫秒） */
    queueVoiceDuration(ms) {
      wx.__voiceDuration = ms;
    },
    recorder,
    bootstrapApp,
    createPage,
    closePage(page) {
      if (page && page.onUnload) page.onUnload();
    },
    tempURL
  };
}

/** 等所有 Promise / setTimeout(0) 落地：页面里的 async 链走完 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

module.exports = { createRuntime, settle, setByPath, MP_ROOT, API_ROOT };
