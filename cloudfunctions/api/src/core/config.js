/**
 * 配置中心
 * 原则：所有可变行为都从环境变量读，代码里不散落魔法值。
 *      云函数环境变量在「云开发控制台 → 云函数 → 配置」里设置，改完无需改代码。
 */

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');

module.exports = {
  // dev / prod —— 影响日志详细度与危险操作的放行
  appEnv: env.APP_ENV || 'dev',

  /* ---------------- 大模型 ---------------- */
  llm: {
    // auto：有 key 就走真实 provider，没有就降级规则模板
    // off ：完全不调 LLM（纯规则，用于压测与省钱）
    provider: env.LLM_PROVIDER || 'auto',
    // openai 兼容端点：混元、DeepSeek、豆包、Moonshot 都走这套协议
    baseUrl: env.LLM_BASE_URL || 'https://api.hunyuan.cloud.tencent.com/v1',
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'hunyuan-lite',
    // 单次调用超时（毫秒）。云函数总超时 20s，这里必须留出余量给降级与落库
    timeoutMs: num(env.LLM_TIMEOUT_MS, 12000),
    // 只对超时/5xx 重试，参数类错误不重试（重试也没用，只是烧钱）
    maxRetries: num(env.LLM_MAX_RETRIES, 1),
    temperature: num(env.LLM_TEMPERATURE, 0.6),
    maxTokens: num(env.LLM_MAX_TOKENS, 700),
    // 成本核算单价（元/千 token），默认按混元 lite 的量级估
    priceInPerK: num(env.LLM_PRICE_IN_PER_K, 0.0008),
    priceOutPerK: num(env.LLM_PRICE_OUT_PER_K, 0.002),
    // 全局日预算（分）。超了自动降级规则模板，功能不断、成本不失控
    dailyBudgetCents: num(env.LLM_DAILY_BUDGET_CENTS, 500)
  },

  /* ---------------- 配额与频控 ---------------- */
  quota: {
    // 每个周期（日/周/月）的正式生成次数
    perPeriod: num(env.QUOTA_PER_PERIOD, 1),
    // 手动重试额度（失败重试不消耗正式次数，但也不能无限点）
    retryAllowance: num(env.QUOTA_RETRY, 2),
    // 单用户单日总调用上限，兜住异常刷接口
    perUserPerDay: num(env.QUOTA_USER_DAY, 10)
  },

  /* ---------------- 业务规则 ---------------- */
  biz: {
    maxContentLen: 500,
    maxImages: 9,
    minWeight: 20,
    maxWeight: 300,
    // 补记允许的最大回溯天数（PRD：7 天内）
    backfillDays: 7,
    // 记录太少不生成正式总结（PRD R10-06）
    minRecordsForSummary: 3,
    // 回收站保留天数
    trashRetainDays: 30,
    // streak 重算的观察窗口，覆盖绝大多数用户，避免全表扫
    streakWindowDays: 120,
    pageSizeDefault: 20,
    pageSizeMax: 50
  },

  /* ---------------- 存储与归档 ---------------- */
  storage: {
    // 按月归档开关。单集合超 2000 万文档再打开，别提前优化
    archiveEnabled: bool(env.ARCHIVE_ENABLED, false),
    // 归档后主集合保留月数
    hotMonths: num(env.ARCHIVE_HOT_MONTHS, 12)
  },

  /* ---------------- 内部调用 ---------------- */
  // 定时任务调 api 时携带的口令，防止外部伪造 admin 动作
  internalToken: env.INTERNAL_TOKEN || ''
};
