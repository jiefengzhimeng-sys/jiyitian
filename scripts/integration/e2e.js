/**
 * 前后端联调：真实页面代码 × 真实云函数 × 内存数据库
 *
 * 运行（在 jiyitian 目录下）：
 *   node scripts/integration/e2e.js
 *
 * 与 cloudfunctions/api/scripts/local-test.js 的区别：
 *   local-test 只测后端（直接调 action）；
 *   本脚本从**页面**开始 —— 点页面方法 → services/cloud-repository → wx.cloud.callFunction
 *   → api.main → service → dao → 内存数据库，链路里没有任何 mock 的业务代码。
 *   凡是页面用错字段、接口少了返回、前后端口径不一致，这里都会红。
 */

const path = require('path');
const assert = require('assert');

/* ------------------------------------------------------------------ */
/* 0. 环境：内存云 + 强制走真实仓储（USE_MOCK=false）                   */
/* ------------------------------------------------------------------ */
process.env.APP_ENV = 'dev';
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_DAILY_BUDGET_CENTS = '500';
process.env.INTERNAL_TOKEN = 'e2e-token';

const { createFakeCloud, install } = require('../../cloudfunctions/api/scripts/memory-cloud');

const cloud = createFakeCloud();
const restore = install(cloud);
const api = require('../../cloudfunctions/api');

const config = require('../../miniprogram/utils/config');
config.USE_MOCK = false;
config.CLOUD_ENV_ID = 'test-env';

const { createRuntime, settle, MP_ROOT } = require('./mini-runtime');

const rt = createRuntime({ cloud, api, openid: 'openid_e2e_A' });

// 页面、仓储都必须在 wx 全局与 config 就绪之后再加载
const repo = require(path.join(MP_ROOT, 'services/index.js'));
const dateUtil = require(path.join(MP_ROOT, 'utils/date.js'));

/* ------------------------------------------------------------------ */
/* 1. 断言框架                                                          */
/* ------------------------------------------------------------------ */
let passed = 0;
const failures = [];

function ok(name, detail) {
  passed++;
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    failures.push({ name, msg: e.message });
    console.log(`  ❌ ${name} — ${e.message}`);
  }
}
function section(title) {
  console.log('\n' + title);
}
const eq = (a, b, msg) => assert.strictEqual(a, b, `${msg || ''}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`);
const truthy = (v, msg) => assert.ok(v, msg || `期望为真，实际 ${JSON.stringify(v)}`);

/** 页面里 feedback.fail 会走 showToast，用它反查页面是否静默失败 */
function lastToast() {
  const t = rt.log.toasts[rt.log.toasts.length - 1];
  return t ? t.title : '';
}
function clearToasts() {
  rt.log.toasts.length = 0;
}

const today = dateUtil.todayKey();
const yesterday = dateUtil.shiftDay(-1);
const before2 = dateUtil.shiftDay(-2);

/* ------------------------------------------------------------------ */
/* 2. 冷启动                                                            */
/* ------------------------------------------------------------------ */
async function boot() {
  section('① 冷启动与身份');
  rt.bootstrapApp();
  await settle();

  await check('user.init 建立档案并回填 openid', async () => {
    truthy(rt.app.globalData.openid, 'app.globalData.openid 空 —— 前端拿不到 openid，云存储路径会拼成 records//…');
    eq(rt.app.globalData.cloudReady, true, 'cloudReady');
  });

  await check('空库首页不报错，柱条占位正常', async () => {
    const home = rt.createPage('pages/home/home.js');
    home.onLoad();
    home.onShow();
    await settle();
    eq(home.data.loading, false, 'loading 未收起');
    eq(home.data.records.length, 0, '空库不该有记录');
    eq(home.data.bars.length, 7, '近 7 天柱条数量');
    eq(lastToast(), '', '首页空态不该弹错误：' + lastToast());
    rt.closePage(home);
  });
}

/* ------------------------------------------------------------------ */
/* 3. 记录页四条写入路径                                                */
/* ------------------------------------------------------------------ */
async function createViaRecordPage(query, fill) {
  // 每个用例都是一次独立的「进页面 → 记录 → 保存」，先清掉上一个用例的草稿，
  // 否则草稿恢复会把本用例的入口参数带歪（这本身也是 record.js 要修的 bug）
  rt.storage.delete('jy_draft_v1');
  const page = rt.createPage('pages/record/record.js');
  page.onLoad(query || {});
  await settle();
  await fill(page);
  await settle();
  await page.onSubmit();
  await settle();
  const fresh = page.data;
  rt.closePage(page);
  return { page, fresh };
}

async function writeRecords() {
  section('② 记录页：文字 / 图片 / 语音 / 体重（真实上传路径）');

  await check('文字记录：分类 + 情绪落库', async () => {
    clearToasts();
    await createViaRecordPage({ category: 'sport' }, async p => {
      p.onCategoryTap({ currentTarget: { dataset: { key: 'sport' } } });
      p.onInput({ detail: { value: '联调：傍晚快走 30 分钟' } });
      p.onMoodChange({ detail: { value: 'calm' } });
    });
    eq(lastToast(), '记下了', '保存结果提示');
    const res = await repo.listRecords({ dayKey: today, limit: 5 });
    const hit = res.list.find(r => r.content === '联调：傍晚快走 30 分钟');
    truthy(hit, '记录没落库');
    eq(hit.category, 'sport', 'category 映射');
    eq(hit.mood, 'calm', 'mood 映射');
    eq(hit.type, 'text', 'type 映射');
    eq(hit.dayKey, today, 'dayKey 映射');
  });

  await check('图片记录：thumb 存 fileID 而不是 2 小时过期的临时链接', async () => {
    clearToasts();
    rt.queueMedia(['wxfile://a.jpg', 'wxfile://b.jpg']);
    await createViaRecordPage({ tab: 'image', category: 'diet' }, async p => {
      await p.chooseImages();
      p.onInput({ detail: { value: '联调：两顿饭' } });
    });
    eq(lastToast(), '记下了', '保存结果提示');

    const res = await repo.listRecords({ dayKey: today, limit: 5 });
    const hit = res.list.find(r => r.content === '联调：两顿饭');
    truthy(hit, '图片记录没落库');
    eq(hit.type, 'image', 'type');
    eq(hit.images.length, 2, '原图数量');
    eq(hit.thumbs.length, 2, '缩略图数量');
    truthy(hit.images.every(v => v.indexOf('cloud://') === 0), '原图应为 cloud:// fileID');
    truthy(
      hit.thumbs.every(v => v.indexOf('cloud://') === 0),
      '缩略图必须是 cloud:// fileID，落库 https 临时链接 2 小时后列表会全部裂图：' + JSON.stringify(hit.thumbs)
    );
    eq(rt.log.uploads.length, 4, '两图各上传压缩版与原图 = 4 次 uploadFile');
  });

  await check('语音记录：时长与 fileID 落库', async () => {
    clearToasts();
    rt.queueVoiceDuration(4200);
    await createViaRecordPage({ tab: 'voice', category: 'mood' }, async p => {
      p.onTabChange({ currentTarget: { dataset: { key: 'voice' } } });
      await p.startRecord();
      rt.recorder.stop();
      await settle(2);
      p.onMoodChange({ detail: { value: 'tired' } });
    });
    const d = await repo.listRecords({ dayKey: today, limit: 10 });
    const hit = d.list.find(r => r.type === 'voice');
    truthy(hit, '语音记录没落库');
    eq(hit.voice.duration, 4, '语音秒数（后端按四舍五入取整到秒）');
    truthy(hit.voice.fileID.indexOf('cloud://') === 0, '语音也应是 cloud:// fileID');
    eq(lastToast(), '记下了', '保存结果提示');
  });

  await check('体重记录：只有体重时 type 归为 weight', async () => {
    clearToasts();
    await createViaRecordPage({ tab: 'text', focus: 'weight' }, async p => {
      eq(p.data.weightOpen, true, 'focus=weight 应展开体重输入');
      p.onWeightInput({ detail: { value: '62.4' } });
    });
    eq(lastToast(), '记下了', '保存结果提示');
    const res = await repo.listRecords({ dayKey: today, limit: 10 });
    const hit = res.list.find(r => r.type === 'weight');
    truthy(hit, '体重记录没落库');
    eq(hit.weight, 62.4, '体重数值');
    eq(hit.category, 'sport', '默认分类');
  });

  await check('重复点击保存：幂等不产生第二条', async () => {
    const payload = { type: 'text', category: 'other', content: '联调：幂等样本' };
    const a = await repo.createRecord(payload);
    const b = await repo.createRecord(payload);
    eq(a._id, b._id, '5 分钟内同内容应命中幂等');
    const res = await repo.listRecords({ dayKey: today, limit: 50 });
    eq(res.list.filter(r => r.content === '联调：幂等样本').length, 1, '重复落库');
  });
}

/* ------------------------------------------------------------------ */
/* 4. 补历史数据（跨天曲线 & 分页需要）                                  */
/* ------------------------------------------------------------------ */
async function seedHistory() {
  section('③ 补记与批量数据（曲线 / 分页用）');
  await check('补记昨天与前天：允许 7 天内回溯', async () => {
    await repo.createRecord({ type: 'weight', category: 'other', weight: 63.0, dayKey: yesterday });
    await repo.createRecord({ type: 'text', category: 'sport', content: '补记：昨天夜跑', dayKey: yesterday });
    await repo.createRecord({ type: 'weight', category: 'other', weight: 63.2, dayKey: before2 });
    await repo.createRecord({ type: 'image', category: 'diet', content: '补记：前天晚饭', dayKey: before2, images: ['cloud://x/1.jpg'] });
    const res = await repo.listRecords({ startDay: before2, endDay: today, limit: 50 });
    eq(res.list.filter(r => r.dayKey === yesterday).length, 2, '昨天的记录数');
    eq(res.list.filter(r => r.dayKey === before2).length, 2, '前天的记录数');
  });

  await check('超出 7 天回溯被拒', async () => {
    const far = dateUtil.shiftDay(-20);
    let msg = '';
    try {
      await repo.createRecord({ type: 'text', content: '太久以前', dayKey: far });
    } catch (e) {
      msg = e.friendly || e.message;
    }
    truthy(/最多补记/.test(msg), '应提示最多补记 7 天，实际：' + msg);
  });
}

/* ------------------------------------------------------------------ */
/* 5. 首页                                                            */
/* ------------------------------------------------------------------ */
async function homeFlow() {
  section('④ 首页（今日流 + 近 7 天柱条 + 连续天数）');
  await check('今日记录完整渲染，柱条按天聚合', async () => {
    clearToasts();
    rt.app.globalData.needRefresh = true;
    const home = rt.createPage('pages/home/home.js');
    home.onLoad();
    home.onShow();
    await settle();
    eq(lastToast(), '', '首页不该弹错误：' + lastToast());
    eq(home.data.loading, false, 'loading');
    truthy(home.data.records.length >= 5, '今日记录数应 ≥5，实际 ' + home.data.records.length);
    truthy(home.data.hasRecords, 'hasRecords');
    eq(home.data.streak, 3, '连续天数（今天/昨天/前天都有记录）');
    eq(home.data.bars.length, 7, '柱条数');
    truthy(home.data.moodEmoji !== '✍️', '今日有情绪记录，情绪卡应换成情绪 emoji');
    rt.closePage(home);
  });
}

/* ------------------------------------------------------------------ */
/* 6. 时间线分页                                                        */
/* ------------------------------------------------------------------ */
async function timelineFlow() {
  section('⑤ 时间线：游标分页与跨页去重');
  await check('批量 25 条后一直翻到底，一条不漏', async () => {
    for (let i = 0; i < 25; i++) {
      await repo.createRecord({ type: 'text', category: 'other', content: `联调：分页样本 ${i}` });
    }
    // 期望条数不走 list，走聚合表——两条独立链路互相对账，才算真的「不漏」
    const startDay = dateUtil.recentDays(7, today)[0];
    const expect = (await repo.getStats({ startDay, endDay: today })).totalRecords;

    clearToasts();
    const page = rt.createPage('pages/timeline/timeline.js');
    page.onLoad();
    await settle();
    eq(lastToast(), '', '时间线不该弹错误：' + lastToast());
    eq(page.data.loading, false, 'loading');
    eq(page.data.total, 20, '首屏条数');
    eq(page.data.hasMore, true, 'hasMore');
    truthy(page.data.cursor, '游标不能为空');

    let guard = 0;
    while (page.data.hasMore && guard++ < 40) {
      await page.loadMore();
      await settle(2);
    }

    const allIds = page.data.groups.reduce((a, g) => a.concat(g.items.map(r => r._id)), []);
    eq(new Set(allIds).size, allIds.length, '翻页出现重复记录');
    eq(allIds.length, expect, '翻页结果与聚合总数对不上（丢记录）');

    // 同一天不能在分组里出现两次
    const dayKeys = page.data.groups.map(g => g.dayKey);
    eq(new Set(dayKeys).size, dayKeys.length, '同一天被拆成两个分组');
    truthy(page.data.groups.every(g => g.label && g.weekday), '分组缺少 label/weekday');
    // 组内按时间倒序（跨组不能比：补记会让「旧日期」的记录 createdAt 更大）
    page.data.groups.forEach(g => {
      for (let i = 1; i < g.items.length; i++) {
        truthy(
          g.items[i - 1].createdAt >= g.items[i].createdAt,
          `${g.dayKey} 组内时间乱序`
        );
      }
    });
    rt.closePage(page);
  });
}

/* ------------------------------------------------------------------ */
/* 7. 详情 + 删除                                                       */
/* ------------------------------------------------------------------ */
async function detailFlow() {
  section('⑥ 详情页：字段映射、临时链接、删除');
  let targetId = '';

  await check('详情：thumb 与 origin 分别换成临时链接', async () => {
    const list = await repo.listRecords({ dayKey: today, category: 'diet', limit: 5 });
    const hit = list.list.find(r => r.type === 'image');
    truthy(hit, '找不到图片记录');
    targetId = hit._id;

    clearToasts();
    const page = rt.createPage('pkgA/detail/detail.js');
    page.onLoad({ id: targetId });
    await settle();
    eq(lastToast(), '', '详情不该弹错误：' + lastToast());
    eq(page.data.loading, false, 'loading');
    eq(page.data.missing, false, 'missing');
    eq(page.data.thumbs.length, 2, '内联缩略图数量');
    truthy(page.data.thumbs.every(u => u.indexOf('https://') === 0), '详情内联图应换成临时链接');
    eq(page.data.origins.length, 2, '预览原图数量');
    truthy(page.data.catName, '分类名未翻译');
    eq(page.data.typeName, '图片', '类型名');
    truthy(/^\d{2}:\d{2}$/.test(page.data.timeText), '时间文案：' + page.data.timeText);
    rt.closePage(page);
  });

  await check('详情：删除后列表与详情都取不到', async () => {
    const page = rt.createPage('pkgA/detail/detail.js');
    page.onLoad({ id: targetId });
    await settle();
    await page.onDelete();
    await settle();
    eq(lastToast(), '已删除', '删除结果提示');
    rt.closePage(page);

    const res = await repo.listRecords({ dayKey: today, limit: 50 });
    truthy(!res.list.some(r => r._id === targetId), '软删除后不该出现在列表');
    let msg = '';
    try {
      await repo.getRecord(targetId);
    } catch (e) {
      msg = e.friendly || e.message;
    }
    eq(msg, '这条记录可能已被删除', '删除后读取的错误文案');
  });

  await check('越权：别人的记录按「不存在」处理', async () => {
    const mine = await repo.listRecords({ dayKey: today, limit: 1 });
    const id = mine.list[0]._id;
    rt.setOpenid('openid_e2e_B');
    let msg = '';
    try {
      await repo.getRecord(id);
    } catch (e) {
      msg = e.friendly || e.message;
    }
    rt.setOpenid('openid_e2e_A');
    eq(msg, '这条记录可能已被删除', '越权文案（不能泄露资源存在性）');
  });
}

/* ------------------------------------------------------------------ */
/* 8. 数据页                                                            */
/* ------------------------------------------------------------------ */
async function statsFlow() {
  section('⑦ 数据页：体重曲线 / 情绪分布 / 饮食频次 / 打卡');
  await check('近 7 天统计聚合口径正确', async () => {
    clearToasts();
    const page = rt.createPage('pages/stats/stats.js');
    page.onLoad();
    await settle();
    eq(lastToast(), '', '数据页不该弹错误：' + lastToast());
    eq(page.data.loading, false, 'loading');
    truthy(page.data.totalRecords > 0, 'totalRecords');
    eq(page.data.hasWeight, true, '有体重记录却没画曲线');
    truthy(page.data.weightSeries.length >= 3, '体重点应 ≥3，实际 ' + page.data.weightSeries.length);
    eq(page.data.weightCur, '62.4', '最新体重');
    truthy(page.data.weightTrend === 'down', '从 63.2 降到 62.4 应为下降趋势，实际 ' + page.data.weightTrend);
    eq(page.data.hasMood, true, '有情绪记录却没画环形图');
    truthy(page.data.moodDist.length >= 2, '情绪档位应 ≥2');
    const pctSum = page.data.moodSegments.reduce((s, x) => s + x.percent, 0);
    truthy(Math.abs(pctSum - 100) < 1.5, '环形图百分比应归一化到 100，实际 ' + pctSum);
    truthy(page.data.dietSeries.length === 7, '饮食柱状应为 7 根，实际 ' + page.data.dietSeries.length);
    rt.closePage(page);
  });

  await check('90 天区间仍走常量级聚合（不扫全表）', async () => {
    const far = dateUtil.shiftDay(-89);
    const stats = await repo.getStats({ startDay: far, endDay: today });
    eq(stats.days, 90, '区间天数');
    eq(stats.countByDay.length, 90, 'X 轴不能断点');
  });

  await check('超过 180 天被拒', async () => {
    const far = dateUtil.shiftDay(-200);
    let msg = '';
    try {
      await repo.getStats({ startDay: far, endDay: today });
    } catch (e) {
      msg = e.friendly || e.message;
    }
    truthy(/180/.test(msg), '应提示 180 天上限，实际：' + msg);
  });

  await check('打卡页：连续天数 / 月历点阵 / 徽章', async () => {
    clearToasts();
    const page = rt.createPage('pkgA/checkin/checkin.js');
    page.onLoad();
    await settle();
    eq(lastToast(), '', '打卡页不该弹错误：' + lastToast());
    eq(page.data.streak, 3, '连续天数（今天/昨天/前天都有记录）');
    truthy(page.data.longest >= page.data.streak, 'longest 不能小于 streak');
    truthy(page.data.cells.length > 28, '月历格子数量');
    truthy(page.data.cells.some(c => c.checked), '月历应有已打卡标记');
    truthy(page.data.badges.length >= 4, '徽章数量');
    truthy(page.data.unlockedCount >= 1, '至少解锁「第一笔」');
    rt.closePage(page);
  });
}

/* ------------------------------------------------------------------ */
/* 9. 我的 / 设置                                                       */
/* ------------------------------------------------------------------ */
async function profileFlow() {
  section('⑧ 我的与设置：档案、开关、提醒时间');
  await check('我的页字段齐全（含照片数 / 语音数）', async () => {
    clearToasts();
    const page = rt.createPage('pages/profile/profile.js');
    page.onLoad();
    await settle();
    eq(lastToast(), '', '我的页不该弹错误：' + lastToast());
    eq(page.data.nickname, '阿柠', '默认昵称');
    truthy(page.data.totalRecords > 0, 'totalRecords');
    truthy(page.data.photoCount >= 1, '照片数应 ≥1，实际 ' + page.data.photoCount);
    truthy(page.data.voiceCount >= 1, '语音数应 ≥1，实际 ' + page.data.voiceCount);
    truthy(/年/.test(page.data.since), '注册月份文案：' + page.data.since);
    truthy(page.data.daysTogether > 0, '在一起天数');
    rt.closePage(page);
  });

  await check('开关切换持久化，重新拉取仍然生效', async () => {
    const page = rt.createPage('pages/profile/profile.js');
    page.onLoad();
    await settle();
    await page.onToggle({ currentTarget: { dataset: { field: 'aiSummary' } }, detail: { value: false } });
    await settle();
    const after = await repo.getProfile();
    eq(after.aiSummary, false, '关闭 AI 总结没落库');
    eq(after.reminder, true, '只改了一个开关，其它设置不能被覆盖');
    await page.onToggle({ currentTarget: { dataset: { field: 'aiSummary' } }, detail: { value: true } });
    await settle();
    rt.closePage(page);
  });

  await check('设置页改提醒时间', async () => {
    clearToasts();
    const page = rt.createPage('pkgA/settings/settings.js');
    page.onLoad({});
    await settle();
    eq(lastToast(), '', '设置页不该弹错误：' + lastToast());
    page.onPickTime({ detail: { value: '22:15' } });
    await settle();
    const after = await repo.getProfile();
    eq(after.reminderTime, '22:15', '提醒时间没落库');
    rt.closePage(page);
  });
}

/* ------------------------------------------------------------------ */
/* 10. AI 总结                                                          */
/* ------------------------------------------------------------------ */
async function summaryFlow() {
  section('⑨ AI 总结：未生成态 / 生成 / 缓存命中');
  await check('首次进入 week：返回 null，页面要有「未生成」空态', async () => {
    const s = await repo.getSummary({ type: 'week' });
    eq(s, null, '未生成时应返回 null');
  });

  await check('点击生成：三段块 + 标签 + 免责声明齐全', async () => {
    clearToasts();
    const page = rt.createPage('pkgA/summary/summary.js');
    page.onLoad({ type: 'week' });
    await settle();
    eq(lastToast(), '', '总结页不该弹错误：' + lastToast());
    eq(page.data.loading, false, 'loading');
    eq(page.data.summary, null, '还没生成时 summary 应为空');
    eq(page.data.tooFew, false, '记录足够，不该判成数据不足');

    await page.onGenerate();
    await settle(16);

    eq(lastToast(), '生成好了', '生成结果提示');
    truthy(page.data.summary, '生成后 summary 仍为空');
    eq(page.data.blocks.length, 3, '三段块数量');
    truthy(page.data.blocks.every(b => b.key && b.label && b.text), '块结构缺字段');
    truthy(page.data.summary.title, '标题为空');
    truthy(page.data.summary.disclaimer, '缺免责声明');
    truthy(page.data.summary.generatedBy === 'llm' || page.data.summary.generatedBy === 'rule', 'generatedBy 取值');
    rt.closePage(page);
  });

  await check('再次生成（非 force）：命中缓存，不重复烧 token', async () => {
    const first = await repo.getSummary({ type: 'week' });
    truthy(first && first.generatedAt, '缓存里没有生成时间');
    const again = await repo.generateSummary({ type: 'week' });
    eq(again.generatedAt, first.generatedAt, '未加 force 时应直接返回缓存');
    eq(again.status, 'ready', 'status');
  });

  await check('日总结/月总结同样可用', async () => {
    const day = await repo.generateSummary({ type: 'day' });
    eq(day.status, 'ready', '日总结 status');
    eq(day.periodType, 'day', 'periodType');
    const month = await repo.generateSummary({ type: 'month' });
    eq(month.status, 'ready', '月总结 status');
    eq(month.periodType, 'month', 'periodType');
  });

  await check('总结页统计口径与后端周期一致（周 = 本周一至周日）', async () => {
    // 后端 periodRange('week') 用 ISO 周；页面若用「近 7 天」，跨周就会对不上
    const pageRange = require(path.join(MP_ROOT, 'utils/date.js')).periodRange;
    truthy(typeof pageRange === 'function', '前端缺 periodRange，无法和后端对齐周期口径');
    const front = pageRange('week', today);
    const back = require('../../cloudfunctions/api/src/core/date').periodRange('week', today);
    eq(front.startKey, back.startKey, '周起始');
    eq(front.endKey, back.endKey, '周结束');
    eq(front.periodKey, back.periodKey, 'periodKey');
  });

  await check('非法 type 被拒', async () => {
    let msg = '';
    try {
      await repo.getSummary({ type: 'year' });
    } catch (e) {
      msg = e.friendly || e.message;
    }
    truthy(/day \/ week \/ month/.test(msg), '应提示类型枚举，实际：' + msg);
  });
}

/* ------------------------------------------------------------------ */
/* 11. 入参校验                                                         */
/* ------------------------------------------------------------------ */
async function validationFlow() {
  section('⑩ 入参校验（前后端都不能只靠对方）');
  await check('空记录被拒', async () => {
    let msg = '';
    try {
      await repo.createRecord({ type: 'text', content: '   ' });
    } catch (e) {
      msg = e.friendly || e.message;
    }
    eq(msg, '写点什么再保存吧', '空内容文案');
  });

  await check('体重越界被拒', async () => {
    let msg = '';
    try {
      await repo.createRecord({ type: 'weight', weight: 5 });
    } catch (e) {
      msg = e.friendly || e.message;
    }
    truthy(/体重/.test(msg), '应提示体重范围，实际：' + msg);
  });

  await check('未来日期被拒', async () => {
    let msg = '';
    try {
      await repo.createRecord({ type: 'text', content: '明天的我', dayKey: dateUtil.shiftDay(1) });
    } catch (e) {
      msg = e.friendly || e.message;
    }
    truthy(/还没到/.test(msg), '应提示不能记未来，实际：' + msg);
  });

  await check('未知 action 有兜底文案', async () => {
    const res = await api.main({ action: 'record.nope', payload: {} });
    eq(res.code, 404, '未知接口状态码');
    truthy(/未知的接口/.test(res.message), '未知接口文案');
  });

  await check('内部动作需口令', async () => {
    const res = await api.main({ action: 'admin.reconcile', payload: {} });
    eq(res.code, 403, '无 token 应 403');
  });
}

/* ------------------------------------------------------------------ */
/* 12. 汇总                                                             */
/* ------------------------------------------------------------------ */
async function main() {
  console.log('记一天 · 前后端联调（页面 × 云函数 × 内存库）');
  console.log('USE_MOCK =', config.USE_MOCK, '| 仓储 =', repo.__mode);
  await boot();
  await writeRecords();
  await seedHistory();
  await homeFlow();
  await timelineFlow();
  await detailFlow();
  await statsFlow();
  await profileFlow();
  await summaryFlow();
  await validationFlow();

  console.log('\n' + '─'.repeat(56));
  if (failures.length) {
    console.log(`❌ ${passed} 项通过，${failures.length} 项失败`);
    failures.forEach(f => console.log(`   · ${f.name} — ${f.msg}`));
  } else {
    console.log(`✅ 全部 ${passed} 项通过`);
  }
  console.log('─'.repeat(56));

  if (rt.log.errors.length) {
    console.log('\n页面捕获的异常（feedback.fail 已兜底，但仍是真问题）：');
    rt.log.errors.slice(0, 5).forEach(e => console.log('  ·', e && (e.message || e)));
  }

  restore();
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => {
  console.error('\n联调脚本自身异常：', e);
  process.exit(2);
});
