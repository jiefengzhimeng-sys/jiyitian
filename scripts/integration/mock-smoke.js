/**
 * Mock 链路冒烟（保证 USE_MOCK 开关两边都能跑）
 *
 * 运行：node scripts/integration/mock-smoke.js
 *
 * 为什么单独跑一遍：
 *   这个项目的卖点是「切库只改一个开关，页面代码不动」。
 *   云端联调过了不代表 Mock 也能过 —— mock-repository 是另一套实现，
 *   字段名、空态、排序任何一处漂移，演示时就会翻车。
 *   这里不重复 e2e 的严格断言，只保证：页面主流程跑通 + 关键字段存在。
 */

const path = require('path');

const config = require('../../miniprogram/utils/config');
config.USE_MOCK = true;
config.MOCK_DELAY = 0; // 关掉模拟网络延迟，否则每个断言都要等上百毫秒

const { createRuntime, settle, MP_ROOT } = require('./mini-runtime');

// 不需要云函数：mock 仓储只依赖 wx 的 Storage
const rt = createRuntime({ cloud: null, api: null, openid: 'mock_openid_local' });

const repo = require(path.join(MP_ROOT, 'services/index.js'));
const dateUtil = require(path.join(MP_ROOT, 'utils/date.js'));

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures.push({ name, msg: e.message });
    console.log(`  ❌ ${name} — ${e.message}`);
  }
};
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const lastToast = () => {
  const t = rt.log.toasts[rt.log.toasts.length - 1];
  return t ? t.title : '';
};

async function main() {
  console.log('记一天 · Mock 链路冒烟');
  console.log('USE_MOCK =', config.USE_MOCK, '| 仓储 =', repo.__mode, '\n');

  rt.bootstrapApp();
  await settle();
  check('Mock 模式冷启动，openid 由本地虚拟 id 兜底', () => {
    need(rt.app.globalData.openid, 'globalData.openid 为空');
    need(rt.app.globalData.cloudReady === true, 'cloudReady 应为 true');
  });

  console.log('\n① 页面主流程');
  rt.storage.delete('jy_draft_v1');
  const home = rt.createPage('pages/home/home.js');
  home.onLoad();
  home.onShow();
  await settle();
  check('首页：种子数据可直接渲染', () => {
    need(home.data.loading === false, 'loading 未收起');
    need(home.data.records.length > 0, '种子数据没读到');
    need(home.data.bars.length === 7, '柱条应为 7 条');
    need(home.data.streak > 0, '连续天数应 > 0');
    need(lastToast() === '', '不该弹错误：' + lastToast());
  });
  rt.closePage(home);

  const timeline = rt.createPage('pages/timeline/timeline.js');
  timeline.onLoad();
  await settle();
  check('时间线：分组与游标', () => {
    need(timeline.data.groups.length > 0, '没有分组');
    need(timeline.data.groups.every(g => g.label && g.weekday), '分组缺 label/weekday');
    need(timeline.data.cursor, '游标为空');
  });
  rt.closePage(timeline);

  const stats = rt.createPage('pages/stats/stats.js');
  stats.onLoad();
  await settle();
  check('数据页：三条曲线都有数据源', () => {
    need(stats.data.hasWeight, '体重曲线无数据');
    need(stats.data.hasMood, '情绪环形图无数据');
    need(stats.data.dietSeries.length > 0, '饮食柱状无数据');
    need(lastToast() === '', '不该弹错误：' + lastToast());
  });
  rt.closePage(stats);

  const checkinPage = rt.createPage('pkgA/checkin/checkin.js');
  checkinPage.onLoad();
  await settle();
  check('打卡页：点阵与徽章', () => {
    need(checkinPage.data.cells.length > 28, '月历格子不足');
    need(checkinPage.data.badges.length > 0, '没有徽章');
    need(checkinPage.data.streak > 0, '连续天数为 0');
  });
  rt.closePage(checkinPage);

  const profile = rt.createPage('pages/profile/profile.js');
  profile.onLoad();
  await settle();
  check('我的页：档案字段齐全', () => {
    need(profile.data.nickname, '昵称空');
    need(profile.data.totalRecords > 0, '累计条数 0');
    need(profile.data.photoCount > 0, '照片数 0');
    need(profile.data.voiceCount > 0, '语音数 0');
  });
  rt.closePage(profile);

  console.log('\n② 记录写入');
  rt.storage.delete('jy_draft_v1');
  const record = rt.createPage('pages/record/record.js');
  record.onLoad({ category: 'mood' });
  await settle();
  record.onInput({ detail: { value: 'Mock 冒烟：今天心情还行' } });
  record.onMoodChange({ detail: { value: 'calm' } });
  await record.onSubmit();
  await settle();
  check('记录页：保存成功并回写', () => {
    need(lastToast() === '记下了', '保存提示异常：' + lastToast());
    need(record.data.category === 'mood', '入口参数被草稿覆盖了');
  });
  rt.closePage(record);

  const list = await repo.listRecords({ dayKey: dateUtil.todayKey(), limit: 5 });
  check('列表里能读到刚写的记录', () => {
    need(list.list.some(r => r.content === 'Mock 冒烟：今天心情还行'), '记录没读到');
    need(list.list.every(r => typeof r.createdAt === 'number'), 'createdAt 类型不对');
  });

  console.log('\n③ AI 总结（规则模板降级）');
  const summaryPage = rt.createPage('pkgA/summary/summary.js');
  summaryPage.onLoad({ type: 'week' });
  await settle();
  check('未生成时页面进入空态而不是空白封面', () => {
    need(summaryPage.data.empty === true, '未生成时 empty 应为 true');
    need(summaryPage.data.summary === null, '尚未生成，summary 应为 null');
  });
  await summaryPage.onGenerate();
  await settle(16);
  check('生成后三段块齐全，且带免责声明', () => {
    need(summaryPage.data.summary, '生成后 summary 为空');
    need(summaryPage.data.blocks.length === 3, '三段块数量不对');
    need(summaryPage.data.summary.disclaimer, '缺免责声明');
    need(summaryPage.data.summary.status === 'ready', 'status 应为 ready');
  });
  rt.closePage(summaryPage);

  console.log('\n' + '─'.repeat(56));
  if (failures.length) {
    console.log(`❌ ${passed} 项通过，${failures.length} 项失败`);
    failures.forEach(f => console.log(`   · ${f.name} — ${f.msg}`));
  } else {
    console.log(`✅ Mock 链路全部 ${passed} 项通过`);
  }
  console.log('─'.repeat(56));
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => {
  console.error('冒烟脚本自身异常：', e);
  process.exit(2);
});
