/**
 * AI 总结业务逻辑
 *
 * 完整链路（技术文档 5.5 / 6.3）：
 *   周期计算 → 命中缓存直接返回 → 数据不足则引导 → 配额检查 → LLM 生成
 *   → 风控 → 组装前端结构 + 曲线数据 → 落库 → 记账
 *
 * 三条硬规则：
 *  1. 同一周期只有一条总结（_id 自带去重），重复调用不会产生两份。
 *  2. 用户点「重新生成」走重试额度，不消耗正式次数（PRD R10-07）。
 *  3. LLM 任何环节失败都必须有可展示的内容（规则模板兜底），不允许空白。
 */

const summaryDao = require('../dao/summaries');
const quotaDao = require('../dao/quota');
const recordsDao = require('../dao/records');
const audit = require('../dao/auditLogs');
const statsService = require('./statsService');
const llm = require('./llm');
const dateUtil = require('../core/date');
const config = require('../core/config');
const logger = require('../core/logger');
const { bad, quota: quotaErr } = require('../core/errors');

const TYPE_MAP = { day: 'day', week: 'week', month: 'month', daily: 'day', weekly: 'week', monthly: 'month' };

/** 前端传 day/week/month，也兼容 daily/weekly/monthly */
function normalizeType(t) {
  const v = TYPE_MAP[t || 'week'];
  if (!v) throw bad('总结类型只能是 day / week / month');
  return v;
}

/** 生成中的锁有效期：超过这个时间认为上次生成挂了，允许重新触发 */
const LOCK_TTL = 90 * 1000;

/**
 * 读取已生成的总结
 * @returns {object|null} 前端 DTO；null 表示还没生成过
 */
async function get(userId, params) {
  const type = normalizeType((params || {}).type);
  const range = dateUtil.periodRange(type, (params || {}).refKey);
  const doc = await summaryDao.get(userId, type, range.periodKey);
  if (!doc) return null;

  // 生成中且未超时：返回 null 让前端显示「生成」按钮
  // 不返回 {status:'generating'}，因为前端把 blocks 为空当成空白页，体验更差
  if (doc.status === summaryDao.STATUS.GENERATING) {
    if (Date.now() - (doc.startedAt || 0) < LOCK_TTL) return null;
  }

  if (doc.status === summaryDao.STATUS.INSUFFICIENT) {
    return Object.assign({ status: 'insufficient' }, doc.content || emptyContent(type));
  }

  if (doc.status !== summaryDao.STATUS.READY) return null;

  // 过期判断：生成后用户又记了新内容，提示可以重新生成
  const agg = await require('../dao/dailyAgg').getRange(userId, range.startKey, range.endKey);
  const nowCount = agg.reduce((s, a) => s + (a.recordCount || 0), 0);
  const stale = type === 'day' ? nowCount !== doc.recordCount : false;

  return Object.assign({}, doc.content, {
    status: 'ready',
    stale,
    periodType: type,
    periodKey: range.periodKey,
    generatedBy: doc.generatedBy,
    generatedAt: doc.generatedAt,
    safety: doc.safetyLevel || 'pass'
  });
}

/**
 * 生成（或重新生成）总结
 * @param {object} params {type, refKey, force}
 */
async function generate(userId, params) {
  const p = params || {};
  const type = normalizeType(p.type);
  const range = dateUtil.periodRange(type, p.refKey);

  const exist = await summaryDao.get(userId, type, range.periodKey);

  // 已有可用结果且不是强制重生成 → 直接返回，省一次 LLM 调用
  if (exist && exist.status === summaryDao.STATUS.READY && !p.force) {
    return get(userId, { type, refKey: p.refKey });
  }
  // 生成中：防并发重复调用（用户连点两次按钮、或定时任务正在预生成）
  if (
    exist &&
    exist.status === summaryDao.STATUS.GENERATING &&
    Date.now() - (exist.startedAt || 0) < LOCK_TTL
  ) {
    // 返回 null 而不是裸状态：前端据此显示生成按钮，不会渲染成空白页
    return null;
  }

  // 数据准备
  const stats = await statsService.overview(userId, { startDay: range.startKey, endDay: range.endKey });
  const label = dateUtil.periodLabel(type, range);

  // 数据不足：不生成正式总结，给引导（PRD R10-06）
  if (stats.totalRecords < config.biz.minRecordsForSummary) {
    const content = insufficientContent(type, label, stats);
    await summaryDao.save(userId, type, range.periodKey, {
      status: summaryDao.STATUS.INSUFFICIENT,
      content,
      recordCount: stats.totalRecords,
      generatedBy: 'none',
      generatedAt: Date.now()
    });
    return Object.assign({ status: 'insufficient' }, content);
  }

  // 配额：首次生成用 official，force 重生成用 retry
  const kind = p.force && exist ? 'retry' : 'official';
  const today = dateUtil.todayKey();
  const q = await quotaDao.consume({
    userId,
    date: today,
    periodType: type,
    kind,
    limits: {
      perPeriod: config.quota.perPeriod,
      retryAllowance: config.quota.retryAllowance,
      perUserPerDay: config.quota.perUserPerDay
    }
  });

  if (!q.allowed) {
    audit.log({
      userId,
      action: audit.ACTIONS.QUOTA_DENIED,
      target: `${type}:${range.periodKey}`,
      result: 'denied',
      reason: q.reason
    });
    const msg =
      q.reason === 'retry_limit'
        ? '这个周期的重试次数用完了，下次周期再生成吧'
        : q.reason === 'daily_call_limit'
        ? '今天用得太频繁了，明天再来'
        : '这个周期的总结已经生成过了';
    throw quotaErr(msg);
  }

  // 先标记生成中再调 LLM：并发请求会看到这个状态，不会重复调用
  await summaryDao.markGenerating(userId, type, range.periodKey);

  const records = await recordsDao.listForSummary(userId, range.startKey, range.endKey, 300);
  const baseline = await loadBaseline(userId, type, range);

  const t = logger.timer();
  const result = await llm.generate({
    periodType: type,
    periodLabel: label,
    stats,
    records,
    baseline
  });
  t.mark('generate');

  // 记账（无论成功失败，token 都烧掉了）
  if (result.meta && (result.meta.promptTokens || result.meta.completionTokens)) {
    await quotaDao.recordUsage(userId, today, type, {
      promptTokens: result.meta.promptTokens,
      completionTokens: result.meta.completionTokens,
      costCents: result.meta.costCents
    }).catch(() => {});
  }

  const chartData = buildChart(stats);
  const content = result.ok
    ? toFrontendContent(result.data, {
        type,
        label,
        stats,
        generatedBy: 'llm',
        meta: result.meta,
        chartData
      })
    : toFrontendContent(ruleSummary(type, label, stats, records), {
        type,
        label,
        stats,
        generatedBy: 'rule',
        meta: result.meta,
        chartData
      });

  await summaryDao.save(userId, type, range.periodKey, {
    status: summaryDao.STATUS.READY,
    content,
    chartData,
    recordCount: stats.totalRecords,
    generatedBy: content.generatedBy,
    model: result.meta ? result.meta.model : '',
    tokens: result.meta ? result.meta.promptTokens + result.meta.completionTokens : 0,
    costCents: result.meta ? result.meta.costCents : 0,
    safetyLevel: result.meta ? result.meta.safetyLevel : 'pass',
    fallbackReason: result.ok ? '' : (result.meta && result.meta.fallbackReason) || 'unknown',
    latencyMs: t.elapsed,
    generatedAt: Date.now()
  });

  audit.log({
    userId,
    action: audit.ACTIONS.AI_SUMMARY,
    target: `${type}:${range.periodKey}`,
    result: content.generatedBy,
    reason: result.ok ? '' : (result.meta && result.meta.fallbackReason) || '',
    meta: result.meta
      ? { tokens: result.meta.promptTokens + result.meta.completionTokens, costCents: result.meta.costCents }
      : null
  });

  logger.info('summary.generate 完成', {
    action: 'summary.generate',
    userId,
    type,
    periodKey: range.periodKey,
    generatedBy: content.generatedBy,
    records: stats.totalRecords,
    ms: t.elapsed,
    marks: t.marks
  });

  return Object.assign({ status: 'ready' }, content, {
    periodType: type,
    periodKey: range.periodKey,
    stale: false,
    safety: (result.meta && result.meta.safetyLevel) || 'pass'
  });
}

/** 上期数据，用于让模型做对比而不是复述 */
async function loadBaseline(userId, type, range) {
  try {
    const prev = dateUtil.prevPeriodRange(type, range.startKey);
    return await statsService.overview(userId, { startDay: prev.startKey, endDay: prev.endKey });
  } catch (e) {
    return null;
  }
}

/** 曲线数据：与总结一起返回，前端不用再请求一次统计接口 */
function buildChart(stats) {
  return {
    weight: stats.weightSeries || [],
    mood: (stats.moodDist || []).map(m => ({ key: m.key, name: m.name, percent: m.percent, color: m.color })),
    diet: stats.dietByDay || [],
    count: stats.countByDay || []
  };
}

/**
 * 结构化结果 → 前端展示结构
 * 前端渲染的是 blocks 数组（key/label/text），这里做最后一层适配，
 * 让前端完全不感知 LLM 的原始输出格式。
 */
function toFrontendContent(data, ctx) {
  const review = data.review || {};
  const trend = data.trend || {};
  const advice = data.advice || {};

  const reviewText = [review.text]
    .concat((review.highlights || []).length ? [`（${review.highlights.join('、')}）`] : [])
    .join('');

  // label 单独占一行，必须短；引导语放进 text 开头
  const adviceText = (advice.text ? advice.text + '：' : '') +
    (advice.items || [])
      .slice(0, 3)
      .map((s, i) => `${['①', '②', '③'][i]} ${s}`)
      .join('；');

  return {
    title: data.title,
    subtitle: data.subtitle,
    blocks: [
      { key: 'review', label: '内容回顾', text: reviewText },
      { key: 'trend', label: '趋势觉察', text: trend.text },
      { key: 'suggest', label: '试试这三件小事', text: adviceText }
    ],
    tags: data.tags || [],
    generatedBy: ctx.generatedBy,
    rangeLabel: ctx.label,
    stats: {
      totalRecords: ctx.stats.totalRecords,
      sportDays: ctx.stats.sportDays,
      weightDelta: ctx.stats.weightDelta,
      moodTop: ctx.stats.moodTop
    },
    chart: ctx.chartData,
    disclaimer: llm.DISCLAIMER,
    createdAt: Date.now()
  };
}

/**
 * 规则模板兜底（技术文档 6.8 第 4 层）
 * 目标：LLM 全挂时，用户看到的仍然是一段读得下去的、基于真实数据的回顾。
 * 不追求文采，追求「每句话都有数据支撑」。
 */
function ruleSummary(type, label, stats, records) {
  const typeName = type === 'day' ? '今天' : type === 'week' ? '这一周' : '这个月';
  const days = stats.days;
  const shownDays = (stats.countByDay || []).filter(d => d.count > 0).length;

  // 内容回顾
  const parts = [];
  if (stats.sportCount) parts.push(`运动 ${stats.sportCount} 次`);
  if (stats.dietCount) parts.push(`饮食 ${stats.dietCount} 条`);
  if (stats.voiceCount) parts.push(`语音 ${stats.voiceCount} 段`);
  if (stats.imageCount) parts.push(`照片 ${stats.imageCount} 张`);

  let review = `${label}记了 ${stats.totalRecords} 条${parts.length ? '，' + parts.join('、') : ''}，`;
  review += `覆盖 ${shownDays}/${days} 天。`;
  if (stats.moodTop) {
    review += `情绪出现最多的是「${stats.moodTop.name}」，占 ${stats.moodTop.percent}%`;
    review += stats.moodTotal > 3 ? `（共 ${stats.moodTotal} 次心情记录）。` : '。';
  }

  // 趋势觉察：只讲有数据的部分，不硬凑
  const trend = [];
  if (stats.weightDelta !== null && stats.weightDelta !== undefined) {
    const d = stats.weightDelta;
    if (Math.abs(d) < 0.2) trend.push('体重基本持平，节奏很稳。');
    else if (d < 0) trend.push(`体重比期初下降 ${Math.abs(d).toFixed(1)} 公斤${Math.abs(d) > 2 ? '，降幅偏快，注意别掉肌肉' : '，属于能维持的速度'}。`);
    else trend.push(`体重上升 ${d.toFixed(1)} 公斤，可以回看这几天的饮食记录找找原因。`);
  } else if (stats.weightSeries && stats.weightSeries.length === 1) {
    trend.push('体重只有一次记录，还画不出曲线，多称两次就能看出方向。');
  }

  trend.push(`有 ${stats.sportDays} 天记录了运动，占 ${Math.round((stats.sportDays / Math.max(1, days)) * 100)}%。`);

  // 记录节奏：断档是比「运动几天」更扎心的指标，也最容易被用户忽略
  if (shownDays < days) {
    trend.push(`记录覆盖 ${shownDays}/${days} 天，空着的那几天往往也是情绪和饮食最容易失控的时候。`);
  } else {
    trend.push(`${days} 天里每天都在记，节奏保持住了。`);
  }

  if (stats.lowAfterSedentary) {
    trend.push(`低落与疲惫合计占 ${Math.round(stats.lowRatio * 100)}%，比平时偏高，值得留意这几天的作息。`);
  } else if (stats.moodTotal > 0 && stats.moodTop) {
    trend.push(`情绪记录 ${stats.moodTotal} 次，以「${stats.moodTop.name}」为主。`);
  }

  if (!trend.length) trend.push('这段时间数据还比较少，多记几天趋势会更清楚。');

  // 建议：全部基于缺口，不写空话
  const items = [];
  if (stats.sportDays < 3) items.push('每周挑 3 天，每次 20 分钟快走，比一次练很猛更容易坚持');
  if (stats.dietCount < shownDays * 2) items.push('每餐拍一张照片就够，不用写文字');
  if (stats.lowAfterSedentary) items.push('睡前一小时不看手机，试试连续三天');
  if (items.length < 3) items.push('保持现在的记录节奏就好，不用加量');
  if (items.length < 3) items.push('睡前把当天最想记住的一件事写一句');

  return {
    title:
      stats.moodTotal && stats.moodTop && stats.moodTop.percent > 40
        ? `${typeName}有点累，但你一直在记`
        : `${typeName}，节奏还不错`,
    subtitle: `${stats.totalRecords} 条记录 · ${stats.sportDays} 天有运动`,
    review: { text: review, highlights: [] },
    trend: { text: trend.join(''), highlights: [] },
    advice: { text: '从最容易的开始', items: items.slice(0, 3) },
    tags: [
      stats.weightDelta !== null ? '体重曲线' : null,
      stats.moodTop ? `${stats.moodTop.name}最多` : null,
      `运动 ${stats.sportDays} 天`
    ].filter(Boolean)
  };
}

/** 数据不足时的引导文案 */
function insufficientContent(type, label, stats) {
  const typeName = type === 'day' ? '今天' : type === 'week' ? '这一周' : '这个月';
  return {
    title: `${typeName}记录还太少`,
    subtitle: `${stats.totalRecords} 条记录`,
    blocks: [
      {
        key: 'review',
        label: '内容回顾',
        text: `${label}只记了 ${stats.totalRecords} 条，AI 还读不出规律。再记几天，总结会更有洞察。`
      }
    ],
    tags: [],
    generatedBy: 'none',
    rangeLabel: label,
    disclaimer: llm.DISCLAIMER,
    createdAt: Date.now()
  };
}

function emptyContent(type) {
  return insufficientContent(type, '', { totalRecords: 0 });
}

/** 定时任务用：批量预生成（不抛错，单用户失败不影响整批） */
async function preGenerate(userId, type) {
  try {
    const prev = dateUtil.prevPeriodRange(type, dateUtil.todayKey());
    const r = await generate(userId, { type, refKey: prev.startKey });
    return { ok: true, status: r && r.status, periodKey: prev.periodKey };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'unknown' };
  }
}

module.exports = { normalizeType, get, generate, preGenerate, ruleSummary, buildChart };
