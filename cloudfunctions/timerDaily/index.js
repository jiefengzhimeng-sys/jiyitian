/**
 * 每日定时任务（调度器）
 *
 * 为什么它是一个「薄调度器」而不是自己实现一套业务：
 *   云函数的目录是隔离打包的，timerDaily 无法 require ../api/src 的代码。
 *   如果在这里复制一份聚合/总结逻辑，改字段就要改两处，迟早不一致。
 *   所以这里只做：扫用户 → 分批调 api 的内部动作 → 汇总报告。
 *   业务逻辑只有一份，在 api 里。
 *
 * 职责：
 *   1. 重算活跃用户的 streak（跨天后「昨天记没记」变了，必须重算）
 *   2. 预生成已结束周期的总结（昨日日报 / 上周周报 / 上月月报）
 *   3. 物理清理回收站到期记录与过期配额
 *   4. 发送打卡提醒（订阅消息，需配置模板 ID）
 *
 * 时间预算：云函数默认 20s，本任务按 BUDGET_MS 主动收尾，
 * 处理不完就留下次（定时任务每天多次触发也可以，做到幂等即可）。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const BUDGET_MS = Number(process.env.TIMER_BUDGET_MS || 18000);
const USER_BATCH = Number(process.env.TIMER_USER_BATCH || 50);
const MAX_USERS = Number(process.env.TIMER_MAX_USERS || 500);
const TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_ID || '';

const pad = n => (n < 10 ? '0' + n : '' + n);

/** 时区必须固定 +8：云函数运行时是 UTC，直接用 getHours 会让任务在错误的时间点判断 */
function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}
function todayKey() {
  const d = beijingNow();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function hhmm() {
  const d = beijingNow();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 调 api 云函数（内部动作需要 token） */
async function callApi(action, payload) {
  const res = await cloud.callFunction({
    name: 'api',
    data: {
      action,
      payload: payload || {},
      token: process.env.INTERNAL_TOKEN || ''
    }
  });
  const body = (res && res.result) || {};
  if (body.code !== 0) {
    throw new Error(`${action} 失败: ${body.message || body.code}`);
  }
  return body.data;
}

/**
 * 扫用户
 * 数据源用 user_stats（每个进过小程序的用户都有），按 updatedAt 升序轮转，
 * 保证长期没动的用户也能被扫到（否则 streak 断了也不知道）。
 */
async function scanUsers(skip, limit) {
  const res = await db
    .collection('user_stats')
    .field({ _id: true })
    .orderBy('updatedAt', 'asc')
    .skip(skip)
    .limit(limit)
    .get();
  return (res.data || []).map(d => d._id);
}

/** 发送打卡提醒（订阅消息一次性授权，发一条扣一次额度） */
async function sendReminders(report) {
  if (!TEMPLATE_ID) {
    report.reminders = { skipped: 'no_template_id' };
    return;
  }
  const now = hhmm();
  const today = todayKey();

  const res = await db
    .collection('reminders')
    .where({
      remindOn: true,
      remindTime: _.lte(now),
      quotaLeft: _.gt(0),
      lastSentDate: _.neq(today)
    })
    .limit(100)
    .get();

  const due = res.data || [];
  let sent = 0;
  let failed = 0;

  for (const r of due) {
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: r.userId,
        templateId: TEMPLATE_ID,
        page: 'pages/record/record',
        miniprogramState: process.env.MP_STATE || 'formal',
        lang: 'zh_CN',
        data: {
          // 字段名必须与后台配置的模板一致，改模板要同步改这里
          thing1: { value: '今天还没记，一句话也算' },
          time2: { value: today + ' ' + now }
        }
      });
      // 扣额度 + 标记已发，避免同一天重复打扰
      await db
        .collection('reminders')
        .doc(r._id)
        .update({
          data: {
            quotaLeft: _.inc(-1),
            lastSentAt: Date.now(),
            lastSentDate: today,
            sentCount: _.inc(1)
          }
        });
      sent++;
    } catch (e) {
      failed++;
      // 43101 = 用户拒收；把额度清零，别每天白试
      if (String(e.errCode) === '43101' || /refuse|43101/.test(e.errMsg || '')) {
        await db.collection('reminders').doc(r._id).update({ data: { quotaLeft: 0, remindOn: false } });
      }
    }
  }

  report.reminders = { due: due.length, sent, failed };
}

exports.main = async (event) => {
  const started = Date.now();
  const today = todayKey();
  const report = {
    date: today,
    trigger: (event && event.TriggerName) || 'manual',
    users: 0,
    streakOk: 0,
    summaries: 0,
    purge: 0,
    cleanup: 0,
    errors: [],
    partial: false
  };

  // 两个触发器共用这个函数，必须按触发器名分流：
  // remindTimer 每 30 分钟跑一次，只该发提醒；重跑全量会白白烧资源
  const onlyRemind = report.trigger === 'remindTimer';
  if (onlyRemind) {
    try {
      await sendReminders(report);
    } catch (e) {
      report.errors.push({ stage: 'remind', msg: e.message });
    }
    report.elapsedMs = Date.now() - started;
    console.log('[timerDaily]', JSON.stringify(report));
    return report;
  }

  let skip = 0;
  while (report.users < MAX_USERS) {
    if (Date.now() - started > BUDGET_MS) {
      report.partial = true;
      break;
    }

    let users;
    try {
      users = await scanUsers(skip, USER_BATCH);
    } catch (e) {
      report.errors.push({ stage: 'scan', msg: e.message });
      break;
    }
    if (!users.length) break;

    for (const userId of users) {
      if (Date.now() - started > BUDGET_MS) {
        report.partial = true;
        break;
      }
      try {
        // 只重算近 2 天有变更的用户，成本从 O(全表) 降到 O(活跃用户)
        await callApi('admin.reconcileUser', { userId, days: 2 });
        report.streakOk++;
      } catch (e) {
        report.errors.push({ userId, stage: 'reconcile', msg: e.message });
      }
    }

    report.users += users.length;
    skip += users.length;
    if (report.partial) break;
  }

  // ---------- 周期总结预生成 ----------
  // 用北京时间判断：周一生成上周周报，每月 1 号生成上月月报，每天都生成昨日日报
  const bj = beijingNow();
  const dow = bj.getUTCDay(); // 0=周日
  const dom = bj.getUTCDate();
  const jobs = ['day'];
  if (dow === 1) jobs.push('week');
  if (dom === 1) jobs.push('month');

  try {
    for (const type of jobs) {
      const res = await db.collection('user_stats').field({ _id: true }).limit(200).get();
      for (const u of res.data || []) {
        if (Date.now() - started > BUDGET_MS) {
          report.partial = true;
          break;
        }
        try {
          const r = await callApi('admin.genSummary', { userId: u._id, type });
          if (r && r.status === 'ready') report.summaries++;
        } catch (e) {
          // 数据不足会走到 insufficient，不算错误
          if (!/quota|次数/.test(e.message || '')) {
            report.errors.push({ userId: u._id, stage: 'summary:' + type, msg: e.message });
          }
        }
      }
    }
  } catch (e) {
    report.errors.push({ stage: 'summary', msg: e.message });
  }

  // ---------- 清理 ----------
  try {
    const p = await callApi('admin.purgeTrash', { retainDays: 30, batch: 100 });
    report.purge = p.removed;
    const c = await callApi('admin.cleanup', { quotaDays: 90, auditDays: 180, batch: 100 });
    report.cleanup = c.quotaRemoved + c.auditRemoved;
  } catch (e) {
    report.errors.push({ stage: 'cleanup', msg: e.message });
  }

  // ---------- 提醒 ----------
  try {
    await sendReminders(report);
  } catch (e) {
    report.errors.push({ stage: 'remind', msg: e.message });
  }

  report.elapsedMs = Date.now() - started;
  console.log('[timerDaily]', JSON.stringify(report));
  return report;
};
