/**
 * 大模型编排入口
 *
 * 四层降级（技术文档 6.8）：
 *   ① 未配置 / 关闭 LLM          → 直接走规则模板，不浪费时间
 *   ② 调用失败（超时/网络/5xx）   → 已内置一次重试，仍失败则降级规则模板
 *   ③ 输出结构不合格              → 降级规则模板（不把半个 JSON 塞给前端）
 *   ④ 内容风控拦截                → 追加更严格约束重生成一次，仍拦截则降级
 *
 * 关键设计：这个函数永远不抛异常。
 *   上层（summaryService）不需要 try/catch，只要看 ok 字段决定用哪份文案。
 *   这样「AI 挂了但功能空白」这种事故从架构上就不可能出现。
 */

const config = require('../../core/config');
const logger = require('../../core/logger');
const prompt = require('./prompt');
const schema = require('./schema');
const safety = require('./safety');
const cost = require('./cost');
const openai = require('./providers/openaiCompatible');
const mock = require('./providers/mock');

/** 选 provider：返回 null 表示不调 LLM */
function resolveProvider() {
  const mode = config.llm.provider;

  if (mode === 'off') return { provider: null, reason: 'disabled' };
  if (mode === 'mock') return { provider: mock, reason: 'mock' };

  // auto：三要素齐全才认为可调
  const { apiKey, baseUrl, model } = config.llm;
  if (apiKey && baseUrl && model) {
    return { provider: openai, reason: 'configured' };
  }
  return { provider: null, reason: 'not_configured' };
}

/** 配置自检：部署后可在控制台直接调，确认 key 与网络是否通 */
function inspect() {
  const r = resolveProvider();
  return {
    provider: r.provider ? r.provider.name : null,
    reason: r.reason,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
    hasKey: !!config.llm.apiKey,
    timeoutMs: config.llm.timeoutMs,
    budgetCentsPerDay: config.llm.dailyBudgetCents,
    priceInPerK: config.llm.priceInPerK,
    priceOutPerK: config.llm.priceOutPerK
  };
}

/**
 * 生成总结内容
 * @param {object} input {periodType, periodLabel, stats, records, baseline}
 * @returns {{ok:boolean, data?:object, raw?:string, meta:object}}
 *   meta: {provider, model, tokens, costCents, latencyMs, attempts, fallbackReason, safety}
 */
async function generate(input) {
  const meta = {
    provider: null,
    model: null,
    promptTokens: 0,
    completionTokens: 0,
    costCents: 0,
    latencyMs: 0,
    attempts: 0,
    fallbackReason: '',
    safetyLevel: 'pass'
  };

  const resolved = resolveProvider();
  if (!resolved.provider) {
    meta.fallbackReason = resolved.reason;
    return { ok: false, meta };
  }

  // 日预算熔断：今天已经烧超了就用规则模板，功能照常、账单封顶
  try {
    const quotaDao = require('../../dao/quota');
    const dateUtil = require('../../core/date');
    const spent = await quotaDao.dayCostCents(dateUtil.todayKey());
    if (spent >= config.llm.dailyBudgetCents) {
      meta.fallbackReason = 'budget_exceeded';
      logger.warn('LLM 日预算已用尽，本次降级规则模板', { spent, budget: config.llm.dailyBudgetCents });
      return { ok: false, meta };
    }
  } catch (e) {
    // 预算查询失败不阻断主流程，继续调用
  }

  const t = logger.timer();
  const messages = prompt.buildMessages(input);
  const startedAt = Date.now();
  // 留 3s 给云函数收尾（落库 + 日志），否则可能因为超时被强杀
  const deadline = startedAt + Math.min(config.llm.timeoutMs + 1000, 14000);

  let res = await resolved.provider.chat({
    system: messages.system,
    user: messages.user,
    model: config.llm.model,
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    deadline,
    periodType: input.periodType
  });

  meta.provider = resolved.provider.name;
  meta.model = res.model || config.llm.model;
  meta.latencyMs = res.latencyMs || 0;
  meta.attempts = res.attempts || 0;

  if (!res.ok) {
    meta.fallbackReason = 'call_failed:' + res.reason;
    logger.warn('LLM 调用失败，降级规则模板', {
      action: 'llm.generate',
      reason: res.reason,
      message: (res.message || '').slice(0, 120),
      latencyMs: res.latencyMs
    });
    return { ok: false, meta };
  }

  // token 与成本（优先用 API 返回的真实 usage）
  const usage = res.usage || {};
  const tokens = usage.promptTokens
    ? usage
    : { promptTokens: messages.estimatedTokens, completionTokens: prompt.estimateTokens(res.text) };
  meta.promptTokens = tokens.promptTokens;
  meta.completionTokens = tokens.completionTokens;
  const c = cost.calc(tokens);
  meta.costCents = c.costCents;

  // 结构校验
  let parsed = schema.parse(res.text);
  if (!parsed.ok) {
    logger.warn('LLM 输出结构不合格，降级规则模板', {
      action: 'llm.generate',
      errors: parsed.errors,
      rawHead: String(res.text || '').slice(0, 180)
    });
    meta.fallbackReason = 'invalid_schema';
    return { ok: false, raw: res.text, meta };
  }

  // 内容风控
  let audit = safety.auditSummary(parsed.data);
  meta.safetyLevel = audit.level;

  if (!audit.ok) {
    // 被拦截：追加更严格的约束重生成一次（只这一次，避免无限循环烧钱）
    logger.warn('LLM 输出触发风控，追加约束重生成', {
      action: 'llm.generate',
      hits: audit.hits.map(h => h.tag)
    });
    const retryUser = [
      messages.user,
      '',
      '【重要补充】你上一次的回答包含医疗或诊断类表述，已被系统拦截。',
      '请重新生成，绝对不要出现：疾病名称、用药或补剂建议、就医指导、',
      '对身体指标的医学判断。只描述趋势与生活习惯层面的观察。'
    ].join('\n');

    res = await resolved.provider.chat({
      system: messages.system,
      user: retryUser,
      model: config.llm.model,
      temperature: 0.3, // 降温度，减少发挥
      maxTokens: config.llm.maxTokens,
      timeoutMs: config.llm.timeoutMs,
      maxRetries: 0,
      deadline: deadline + 4000,
      periodType: input.periodType
    });

    meta.attempts += res.attempts || 0;
    if (res.ok) {
      const u2 = res.usage || {};
      const t2 = u2.promptTokens
        ? u2
        : { promptTokens: prompt.estimateTokens(retryUser), completionTokens: prompt.estimateTokens(res.text) };
      meta.promptTokens += t2.promptTokens;
      meta.completionTokens += t2.completionTokens;
      meta.costCents += cost.calc(t2).costCents;

      parsed = schema.parse(res.text);
      audit = parsed.ok ? safety.auditSummary(parsed.data) : { ok: false, level: 'block', hits: [] };
    } else {
      audit = { ok: false, level: 'block', hits: [{ tag: 'retry_failed' }] };
    }

    meta.safetyLevel = audit.level;
    if (!audit.ok) {
      meta.fallbackReason = 'safety_blocked';
      return { ok: false, meta };
    }
  }

  meta.latencyMs = Date.now() - startedAt;
  t.mark('llm');

  logger.info('LLM 生成成功', {
    action: 'llm.generate',
    periodType: input.periodType,
    provider: meta.provider,
    model: meta.model,
    promptTokens: meta.promptTokens,
    completionTokens: meta.completionTokens,
    costCents: meta.costCents,
    safetyLevel: meta.safetyLevel,
    ms: meta.latencyMs
  });

  return { ok: true, data: audit.data, meta };
}

module.exports = { generate, inspect, resolveProvider, DISCLAIMER: safety.DISCLAIMER };
