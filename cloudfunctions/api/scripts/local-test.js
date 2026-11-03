/**
 * 后端本地端到端测试
 *
 * 运行：node scripts/local-test.js   （在 cloudfunctions/api 目录下）
 *
 * 它做的事：把 wx-server-sdk 换成内存实现，然后原样调用云函数入口 main()，
 * 走的是生产环境的同一套代码路径（路由 → service → dao → db），
 * 不 mock 任何业务逻辑，只 mock 存储。
 *
 * 覆盖：12 个对外 action + 6 个内部动作 + 校验/越权/幂等/配额/降级/对账。
 */

process.env.APP_ENV = 'dev';
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_DAILY_BUDGET_CENTS = '500';

const assert = require('assert');
const { createFakeCloud, install } = require('./memory-cloud');

const cloud = createFakeCloud();
const restore = install(cloud);

// 必须在劫持之后 require，才能拿到假 SDK
const api = require('../index');
const dateUtil = require('../src/core/date');

let passed = 0;
const failures = [];

function ok(name, detail) {
  passed++;
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    failures.push({ name, msg: e.message });
    console.log(`  ❌ ${name} — ${e.message}`);
  }
}
function section(title) {
  console.log('\n' + title);
}

/** 调接口：所有测试都走真实入口 */
async function call(action, payload, openid) {
  cloud.__setOpenid(openid || '');
  const res = await api.main({ action, payload: payload || {} });
  return res;
}

/** 断言成功并返回 data */
async function callOk(action, payload, openid) {
  const res = await call(action, payload, openid);
  if (res.code !== 0) {
    throw new Error(`${action} 返回 ${res.code}: ${res.message}`);
  }
  return res.data;
}

const U1 = 'openid_user_A_0001';
const U2 = 'openid_user_B_0002';

function rec(over) {
  return Object.assign(
    {
      type: 'text',
      category: 'sport',
      content: '傍晚在河边快走了 30 分钟，风很大',
      mood: 'calm',
      weight: null,
      images: [],
      thumbs: [],
      voice: null
    },
    over || {}
  );
}

(async () => {
  console.log('=== 记一天 · 后端本地端到端测试 ===');
  console.log('时间口径 todayKey =', dateUtil.todayKey());

  /* ================= 1. 用户初始化 ================= */
  section('1. 用户与档案');
  const init = await callOk('user.init', {}, U1);
  check('user.init 建档成功', () => {
    assert(init.totalRecords === 0, '初始记录数应为 0');
    assert(init.nickname);
    assert(init.aiSummary === true, 'AI 总结默认开启');
  });

  const initAgain = await callOk('user.init', {}, U1);
  check('重复 init 幂等，不产生两个用户', () => {
    assert.strictEqual(initAgain.nickname, init.nickname);
    assert.strictEqual(cloud.__dump('users').length, 1, 'users 集合应只有 1 条');
  });

  /* ================= 2. 创建记录 ================= */
  section('2. 记录创建（业务校验 + 幂等 + 聚合）');
  const today = dateUtil.todayKey();
  const r1 = await callOk('record.create', rec(), U1);
  check('创建文字记录', () => {
    assert(r1._id, '应返回记录 id');
    assert.strictEqual(r1.dayKey, today);
    assert.strictEqual(r1.category, 'sport');
    assert(r1.content.indexOf('快走') >= 0, '内容应完整保存');
  });

  const r2 = await callOk(
    'record.create',
    rec({ type: 'voice', category: 'mood', content: '', mood: 'low', voice: { fileID: 'cloud://voice1.mp3', duration: 42 } }),
    U1
  );
  check('创建语音记录（无文字也可保存）', () => {
    assert.strictEqual(r2.type, 'voice');
    assert.strictEqual(r2.voice.duration, 42);
  });

  const r3 = await callOk(
    'record.create',
    rec({
      type: 'image',
      category: 'diet',
      content: '午饭',
      images: ['cloud://origin1.jpg', 'cloud://origin2.jpg'],
      thumbs: ['cloud://thumb1.jpg', 'cloud://thumb2.jpg']
    }),
    U1
  );
  check('创建图片记录，快照保留 origin/thumb 两档', () => {
    assert.strictEqual(r3.images.length, 2);
    assert.strictEqual(r3.thumbs[0], 'cloud://thumb1.jpg', '列表用 thumb，不该拿原图');
    assert.strictEqual(r3.images[0], 'cloud://origin1.jpg', '大图用 origin');
  });

  const r4 = await callOk('record.create', rec({ type: 'weight', category: 'weight', content: '', mood: '', weight: 62.5 }), U1);
  check('创建体重记录（只有体重也算有效记录）', () => {
    assert.strictEqual(r4.weight, 62.5);
    assert.strictEqual(r4.type, 'weight');
  });

  // 幂等：同样的内容再提交一次
  const dup = await callOk('record.create', rec(), U1);
  check('重复提交命中幂等，不产生第二条', () => {
    assert.strictEqual(dup._id, r1._id, '应返回原记录 id');
    assert.strictEqual(cloud.__dump('records').length, 4, '记录数应仍为 4');
  });

  // 校验分支
  const e1 = await call('record.create', rec({ content: '' }), U1);
  check('空内容被拦截', () => assert.strictEqual(e1.code, 400));
  const e2 = await call('record.create', rec({ content: 'x'.repeat(501) }), U1);
  check('超 500 字被拦截', () => assert.strictEqual(e2.code, 400));
  const e3 = await call('record.create', rec({ weight: 500, content: '' }), U1);
  check('体重越界被拦截', () => assert.strictEqual(e3.code, 400));
  const e4 = await call('record.create', rec({ images: Array(10).fill('cloud://x.jpg') }), U1);
  check('超过 9 张图被拦截', () => assert.strictEqual(e4.code, 400));
  const e5 = await call('record.create', rec({ dayKey: dateUtil.shiftDay(today, -10) }), U1);
  check('补记超过 7 天被拦截', () => assert.strictEqual(e5.code, 400));
  const e6 = await call('record.create', rec({ dayKey: dateUtil.shiftDay(today, 3) }), U1);
  check('未来日期被拦截', () => assert.strictEqual(e6.code, 400));

  // 聚合
  const aggToday = cloud.__dump('daily_aggs').find(a => a.userId === U1 && a.date === today);
  if (process.env.DEBUG_AGG) {
    console.log('DEBUG agg =', JSON.stringify(aggToday));
  }
  check('日聚合同步更新（增量，非全表扫描）', () => {
    assert(aggToday, '应生成今日聚合');
    assert.strictEqual(aggToday.recordCount, 4, '今日 4 条');
    assert.strictEqual(aggToday.byTag.sport, 1);
    assert.strictEqual(aggToday.byTag.diet, 1);
    // r1 与 r3 都带了默认心情 calm，所以 calm 计数为 2
    assert.strictEqual(aggToday.moodCounts.calm, 2);
    assert.strictEqual(aggToday.moodCounts.low, 1);
    assert.strictEqual(aggToday.weight, 62.5, '体重取当日最后一次');
    assert.strictEqual(aggToday.voiceCount, 1);
    assert.strictEqual(aggToday.mediaCount, 2);
  });

  const statsDoc = cloud.__dump('user_stats').find(s => s._id === U1);
  check('streak 与累计条数同步', () => {
    assert.strictEqual(statsDoc.streakCurrent, 1, '今天记了，连续 1 天');
    assert.strictEqual(statsDoc.totalRecords, 4);
  });

  const mediaRows = cloud.__dump('media_assets').filter(m => m.userId === U1);
  check('媒体资产入库（图片 2 + 语音 1）', () => {
    assert.strictEqual(mediaRows.length, 3);
    assert(mediaRows.some(m => m.type === 'audio'));
    assert(mediaRows.every(m => m.recordId && m.status === 'passed'));
  });

  /* ================= 3. 读取与越权 ================= */
  section('3. 读取、越权与游标分页');
  const todayView = await callOk('record.today', {}, U1);
  check('今日视图一次返回记录流 + 小计', () => {
    assert.strictEqual(todayView.records.length, 4);
    assert.strictEqual(todayView.stats.totalRecords, 4);
    assert.strictEqual(todayView.stats.sportCount, 1);
  });

  const detail = await callOk('record.get', { id: r1._id }, U1);
  check('详情可读', () => assert.strictEqual(detail._id, r1._id));

  const otherRead = await call('record.get', { id: r1._id }, U2);
  check('越权读取他人记录被拒（返回不存在，不泄露存在性）', () => {
    assert.strictEqual(otherRead.code, 404);
  });

  // 造 12 条历史记录测分页
  for (let i = 1; i <= 12; i++) {
    await callOk(
      'record.create',
      rec({
        content: `历史记录 ${i}`,
        dayKey: dateUtil.shiftDay(today, -Math.ceil(i / 3)),
        category: i % 3 === 0 ? 'diet' : 'sport'
      }),
      U1
    );
  }

  const p1 = await callOk('record.list', { limit: 5 }, U1);
  const p2 = await callOk('record.list', { limit: 5, cursor: p1.nextCursor }, U1);
  const p3 = await callOk('record.list', { limit: 5, cursor: p2.nextCursor }, U1);
  check('游标分页：三页无重复', () => {
    const ids = new Set();
    [...p1.list, ...p2.list, ...p3.list].forEach(r => ids.add(r._id));
    assert.strictEqual(ids.size, p1.list.length + p2.list.length + p3.list.length, '出现重复记录');
  });

  // 一直翻到底，验证「一条不漏」
  const paged = [...p1.list, ...p2.list, ...p3.list];
  let cursor = p3.nextCursor;
  let hasMore = p3.hasMore;
  let guard = 0;
  while (hasMore && guard++ < 20) {
    const next = await callOk('record.list', { limit: 5, cursor }, U1);
    paged.push(...next.list);
    cursor = next.nextCursor;
    hasMore = next.hasMore;
  }
  check('游标分页：一条不漏（同毫秒写入也不能丢）', () => {
    // 这 16 条是循环里连续写入的，createdAt 极易撞同一毫秒。
    // 游标条件若是 createdAt < cursor，撞点的记录会被整批跳过 —— 这个断言專門守这个坑。
    const ids = new Set(paged.map(r => r._id));
    assert.strictEqual(ids.size, 16, `应翻出全部 16 条，实际 ${ids.size} 条`);
    assert.strictEqual(hasMore, false, '翻到底后应标记结束');
  });

  check('游标分页：按日期倒序，跨页连续', () => {
    for (let i = 1; i < paged.length; i++) {
      const prev = paged[i - 1];
      const cur = paged[i];
      assert(prev.dayKey >= cur.dayKey, `第 ${i} 条日期乱序: ${prev.dayKey} → ${cur.dayKey}`);
    }
    assert(p1.hasMore === true, '第一页应还有更多');
  });

  const filtered = await callOk('record.list', { category: 'diet' }, U1);
  check('按分类筛选', () => {
    assert(filtered.list.length > 0);
    assert(filtered.list.every(r => r.category === 'diet'));
  });

  /* ================= 4. 统计与打卡 ================= */
  section('4. 统计与打卡（读聚合表，不扫全表）');
  const stats = await callOk('stats.overview', { startDay: dateUtil.shiftDay(today, -6), endDay: today }, U1);
  check('统计字段与前端契约一致', () => {
    const need = [
      'totalRecords', 'sportDays', 'dietCount', 'weightSeries', 'weightDelta', 'weightCurrent',
      'moodDist', 'moodTop', 'moodTotal', 'dietByDay', 'countByDay', 'days', 'voiceCount', 'imageCount'
    ];
    const missing = need.filter(k => stats[k] === undefined);
    assert.strictEqual(missing.length, 0, '缺字段: ' + missing.join(','));
    assert.strictEqual(stats.days, 7);
    assert.strictEqual(stats.countByDay.length, 7, 'X 轴必须连续，缺失日补 0');
    assert.strictEqual(stats.countByDay[6].count, 4, '今天 4 条');
  });
  check('体重序列可取到（曲线数据源）', () => {
    assert.strictEqual(stats.weightSeries.length, 1);
    assert.strictEqual(stats.weightSeries[0].value, 62.5);
  });
  check('情绪分布带 name/color/percent', () => {
    assert(stats.moodDist.length === 2);
    assert(stats.moodDist.every(m => m.name && m.color && typeof m.percent === 'number'));
  });

  const checkin = await callOk('checkin.get', {}, U1);
  check('打卡数据：streak / 月历 / 徽章', () => {
    // 分页用例补记了 -1 ~ -4 天的记录，连同今天恰好连成 5 天。
    // 这里同时守住「补记更早的日期也要触发 streak 重算」——早先只判今天/昨天，
    // 补记后首页会一直显示偏小的连续天数。
    assert.strictEqual(checkin.streak, 5, '今天到 4 天前都有记录，连续 5 天');
    assert(checkin.checkedDays.indexOf(today) >= 0, '今天应出现在月历');
    assert(checkin.badges.length >= 4);
    assert(checkin.badges.some(b => b.key === 'first' && b.unlocked), '第一条记录应解锁首个徽章');
  });

  const profile = await callOk('profile.update', { aiSummary: false, reminderTime: '22:00', nickname: '小柠' }, U1);
  check('档案更新：平铺字段写入 settings 对象', () => {
    assert.strictEqual(profile.aiSummary, false);
    assert.strictEqual(profile.reminderTime, '22:00');
    assert.strictEqual(profile.nickname, '小柠');
  });
  check('档案返回前端「我的」页需要的计数与 since', () => {
    // photoCount / voiceCount 是前端页面直接读的字段，缺了会显示 0
    assert.strictEqual(profile.photoCount, 2, '应统计到 2 张图');
    assert.strictEqual(profile.voiceCount, 1, '应统计到 1 条语音');
    assert(profile.since, 'since 用于「一起走过 N 天」');
    assert.strictEqual(typeof profile.totalRecords, 'number');
  });
  const userDoc = cloud.__dump('users').find(u => u._id === U1);
  check('settings 结构落库（前端传平铺，存储用对象）', () => {
    assert.strictEqual(userDoc.settings.aiSummaryOn, false);
    assert.strictEqual(userDoc.settings.remindTime, '22:00');
  });
  // 还原，避免影响后续 AI 测试
  await callOk('profile.update', { aiSummary: true }, U1);

  /* ================= 5. AI 总结（mock provider 全链路） ================= */
  section('5. AI 总结：LLM 生成 + 结构校验 + 风控 + 配额');
  const capability = await callOk('summary.capability', {}, U1);
  check('能力自检返回 provider 信息', () => {
    assert.strictEqual(capability.provider, 'mock');
    assert(capability.model);
  });

  const sum = await callOk('summary.generate', { type: 'week' }, U1);
  check('周总结生成成功（LLM 路径）', () => {
    assert.strictEqual(sum.status, 'ready');
    assert.strictEqual(sum.generatedBy, 'llm', '应走 LLM 而非规则模板');
    assert.strictEqual(sum.blocks.length, 3, '三段式：回顾/趋势/建议');
    assert(sum.blocks.every(b => b.key && b.label && b.text), 'blocks 结构必须完整');
    assert(sum.chart, '应附带曲线数据');
    assert(sum.chart.weight.length >= 1);
    assert(sum.disclaimer.indexOf('不构成任何医疗建议') >= 0, '免责声明必须存在');
  });

  const sumDoc = cloud.__dump('ai_summaries').find(d => d.userId === U1 && d.periodType === 'week');
  check('总结落库：状态/模型/token/成本齐全', () => {
    assert.strictEqual(sumDoc.status, 'ready');
    assert(sumDoc.tokens > 0, '应记录 token 消耗');
    assert(sumDoc.model, '应记录模型标识');
    assert(sumDoc.periodKey.match(/^\d{4}-W\d{2}$/), 'periodKey 应为 ISO 周');
  });

  const cached = await callOk('summary.get', { type: 'week' }, U1);
  check('重复读取走缓存，不重复调用 LLM', () => {
    assert.strictEqual(cached.status, 'ready');
    assert.strictEqual(cached.title, sum.title);
  });

  // 强制重生成 → 走 retry 额度
  const regen1 = await callOk('summary.generate', { type: 'week', force: true }, U1);
  check('force 重生成成功（消耗重试额度，不占正式次数）', () => {
    assert.strictEqual(regen1.status, 'ready');
    const q = cloud.__dump('ai_quota').find(x => x.userId === U1 && x.periodType === 'week');
    assert.strictEqual(q.count, 1, '正式次数仍为 1');
    assert.strictEqual(q.retryCount, 1, '重试次数 +1');
  });

  await callOk('summary.generate', { type: 'week', force: true }, U1);
  const overQuota = await call('summary.generate', { type: 'week', force: true }, U1);
  check('重试额度用尽后拒绝（429）', () => {
    assert.strictEqual(overQuota.code, 429);
    assert(overQuota.message.indexOf('重试') >= 0, '提示应说明是重试次数问题');
  });

  // 数据不足
  await callOk('user.init', {}, U2);
  const sumEmpty = await callOk('summary.generate', { type: 'day' }, U2);
  check('记录不足 3 条时不给正式总结，改为引导', () => {
    assert.strictEqual(sumEmpty.status, 'insufficient');
    assert(sumEmpty.blocks[0].text.indexOf('再记几天') >= 0);
    const doc = cloud.__dump('ai_summaries').find(d => d.userId === U2 && d.periodType === 'day');
    assert.strictEqual(doc.status, 'insufficient');
  });

  /* ================= 6. LLM 降级（三条失败路径） ================= */
  section('6. LLM 四层降级：失败 / 非法输出 / 风控拦截');
  const mockProvider = require('../src/services/llm/providers/mock');
  const originalChat = mockProvider.chat;

  // 6.1 调用失败（超时）
  mockProvider.chat = async () => ({ ok: false, reason: 'timeout', latencyMs: 12000, attempts: 1 });
  const degraded = await callOk('summary.generate', { type: 'day' }, U1);
  check('LLM 超时 → 自动降级规则模板，功能不空白', () => {
    assert.strictEqual(degraded.status, 'ready');
    assert.strictEqual(degraded.generatedBy, 'rule');
    assert(degraded.blocks[1].text.length > 20, '规则模板也要有实质内容');
  });
  const degradedDoc = cloud.__dump('ai_summaries').find(d => d.userId === U1 && d.periodType === 'day');
  check('降级原因写入库，便于排查', () => {
    assert(degradedDoc.fallbackReason.indexOf('call_failed') >= 0);
  });

  // 6.2 输出不是合法 JSON
  mockProvider.chat = async () => ({
    ok: true,
    text: '好的，这是你的周报：今天状态不错，继续保持！',
    model: 'mock',
    usage: { promptTokens: 100, completionTokens: 20 },
    latencyMs: 200,
    attempts: 1
  });
  const badJson = await callOk('summary.generate', { type: 'day', force: true }, U1);
  check('LLM 输出非 JSON → 降级规则模板，不把半个 JSON 塞给前端', () => {
    assert.strictEqual(badJson.generatedBy, 'rule');
    assert(badJson.blocks.length === 3);
  });

  // 6.3 输出含医疗表述（风控拦截）
  let callRound = 0;
  mockProvider.chat = async () => {
    callRound++;
    return {
      ok: true,
      text: JSON.stringify({
        title: '你可能得了焦虑症',
        subtitle: '建议尽快就医',
        review: { text: '这周你的情绪波动很大，建议去医院做个检查。', highlights: [] },
        trend: { text: '建议服用褪黑素改善睡眠，剂量按说明书加倍。', highlights: [] },
        advice: { text: '尽快就医', items: ['去看医生', '吃药', '做检查'] },
        tags: ['健康']
      }),
      model: 'mock',
      usage: { promptTokens: 120, completionTokens: 80 },
      latencyMs: 300,
      attempts: 1
    };
  };
  const blocked = await callOk('summary.generate', { type: 'day', force: true }, U1);
  check('医疗表述被风控拦截 → 重生成一次仍拦截则降级', () => {
    assert.strictEqual(blocked.generatedBy, 'rule');
    assert(callRound === 2, '应追加约束重试且只重试一次，实际调用 ' + callRound + ' 次');
    assert(blocked.title.indexOf('焦虑症') < 0, '拦截内容不得出现在结果里');
  });

  // 6.4 恐吓式表述 → 改写而非拦截
  // 用 month 类型：day 的重试额度已被前面 3 个用例用完，这里验证的是改写逻辑不是配额
  mockProvider.chat = async () => ({
    ok: true,
    text: JSON.stringify({
      title: '这周节奏还行',
      subtitle: '记录 15 条',
      review: { text: '你这周记了不少，可以继续。', highlights: [] },
      trend: { text: '你的体重已经非常危险，需要立刻停止现在的饮食。', highlights: [] },
      advice: { text: '调整一下', items: ['多走路', '早点睡', '多喝水'] },
      tags: ['节奏']
    }),
    model: 'mock',
    usage: { promptTokens: 120, completionTokens: 80 },
    latencyMs: 300,
    attempts: 1
  });
  const softened = await callOk('summary.generate', { type: 'month', force: true }, U1);
  check('恐吓式表述被改写后仍可展示（soften 而非 block）', () => {
    assert.strictEqual(softened.generatedBy, 'llm');
    assert(softened.blocks[1].text.indexOf('危险') < 0, '危险表述应被替换');
    assert(softened.safety === 'soften' || softened.safety === 'pass');
  });

  mockProvider.chat = originalChat;

  /* ================= 7. 删除与回收站 ================= */
  section('7. 删除、聚合回减与越权删除');
  const beforeDelete = (await callOk('record.today', {}, U1)).stats.totalRecords;
  await callOk('record.remove', { id: r3._id }, U1);
  const afterDelete = await callOk('record.today', {}, U1);
  check('删除后今日记录与聚合同步回减', () => {
    assert.strictEqual(afterDelete.stats.totalRecords, beforeDelete - 1);
    assert.strictEqual(afterDelete.stats.dietCount, 0, '被删的是饮食记录');
    const agg = cloud.__dump('daily_aggs').find(a => a.userId === U1 && a.date === today);
    assert.strictEqual(agg.recordCount, 3);
    assert.strictEqual(agg.byTag.diet, 0);
  });

  const delAgain = await call('record.remove', { id: r3._id }, U1);
  check('重复删除返回不存在', () => assert.strictEqual(delAgain.code, 404));

  const delOther = await call('record.remove', { id: r1._id }, U2);
  check('越权删除被拒', () => assert.strictEqual(delOther.code, 404));

  const deletedDoc = cloud.__dump('records').find(r => r._id === r3._id);
  check('软删除进回收站（status=deleted + deletedAt）', () => {
    assert.strictEqual(deletedDoc.status, 'deleted');
    assert(deletedDoc.deletedAt > 0);
  });

  const orphanMedia = cloud.__dump('media_assets').filter(m => m.recordId === r3._id);
  check('媒体标记为孤儿，等定时任务清理（不阻塞删除接口）', () => {
    assert(orphanMedia.every(m => m.status === 'orphan'));
  });

  /* ================= 8. 内部动作与对账 ================= */
  section('8. 内部动作：对账、体检、清理');
  // 人为把聚合改坏，模拟增量更新丢失
  const aggDoc = cloud.__dump('daily_aggs').find(a => a.userId === U1 && a.date === today);
  aggDoc.recordCount = 99;
  aggDoc.byTag.sport = 88;

  const reconcile = await callOk('admin.reconcileUser', { userId: U1, days: 7 }, U1);
  check('对账修正聚合漂移', () => {
    assert(reconcile.fixed >= 1, '应修正至少 1 天');
    const fixedAgg = cloud.__dump('daily_aggs').find(a => a.userId === U1 && a.date === today);
    assert.strictEqual(fixedAgg.recordCount, 3, '应恢复为真实条数');
    assert.strictEqual(fixedAgg.byTag.sport, 1);
  });

  const dbCheck = await callOk('admin.dbCheck', { sample: 50 }, U1);
  check('存储体检：集合计数与脏数据抽样', () => {
    assert(typeof dbCheck.collections.records === 'number');
    assert.strictEqual(dbCheck.dirty.noStatus, 0, '不应有缺 status 的脏数据');
    assert.strictEqual(dbCheck.dirty.noDate, 0);
    assert.strictEqual(dbCheck.dirty.schemaVer > 0 || dbCheck.dirty.noSchemaVer === 0, true);
  });

  const purge = await callOk('admin.purgeTrash', { retainDays: 0, batch: 50 }, U1);
  check('回收站清理（保留 0 天 = 立即物理删除）', () => {
    assert(purge.removed >= 1);
    assert(!cloud.__dump('records').some(r => r._id === r3._id), '记录应被物理删除');
  });

  const cleanup = await callOk('admin.cleanup', { quotaDays: 0, batch: 50 }, U1);
  check('过期配额清理', () => assert(cleanup.quotaRemoved >= 0));

  const adminNoToken = await api.main({ action: 'admin.purgeTrash', payload: {} });
  check('内部动作在 dev 未配 token 时仍可调用（生产会拒绝）', () => {
    assert.strictEqual(adminNoToken.code, 0);
  });

  /* ================= 9. 路由与容错 ================= */
  section('9. 入口容错');
  const unknown = await call('not.exist', {}, U1);
  check('未知 action 返回 404', () => assert.strictEqual(unknown.code, 404));

  cloud.__setOpenid('');
  const noAuth = await api.main({ action: 'record.today', payload: {} });
  check('无身份返回 401', () => assert.strictEqual(noAuth.code, 401));

  const noAction = await api.main({});
  check('缺 action 返回 400', () => assert.strictEqual(noAction.code, 400));

  /* ================= 汇总 ================= */
  console.log('\n=== 结果 ===');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.msg}`));
    restore();
    process.exit(1);
  }
  console.log('✅ 全部通过');
  restore();
  process.exit(0);
})().catch(e => {
  console.error('\n❌ 测试异常中断:', e);
  restore();
  process.exit(1);
});
