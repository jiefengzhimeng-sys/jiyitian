/**
 * 全局运行时配置
 * 切换真实存储：把 USE_MOCK 改成 false，并填好 CLOUD_ENV_ID（云开发控制台 → 设置 → 环境 ID）
 * 业务代码完全不用动 —— 见 services/index.js 的仓储切换
 */
module.exports = {
  // 是否使用本地 Mock 数据（true：不依赖云开发即可完整跑通 UI 与流程）
  USE_MOCK: true,

  // 云开发环境 ID，留空则使用默认环境；正式提审前务必填成正式环境 ID（对应错误对照 E-12）
  CLOUD_ENV_ID: '',

  // 云函数名称
  API_FN: 'api',

  // 业务限制（与技术文档一致）
  MAX_TEXT_LEN: 500,
  MAX_IMAGES: 9,
  MAX_VOICE_MS: 60000,
  WEIGHT_MIN: 20,
  WEIGHT_MAX: 300,

  // 列表分页
  PAGE_SIZE: 20,

  // 缩略图规格：列表用 thumb，详情内联用 preview，全屏用 origin
  THUMB_WIDTH: 320,
  PREVIEW_WIDTH: 1080,

  /**
   * Mock 模拟网络延迟（毫秒）。null 表示按仓库内置的 120~220ms 走，保持真实体感。
   * 只有本地联调脚本会把它设成 0 —— 否则每个断言都要等上百毫秒，跑一遍要几十秒。
   */
  MOCK_DELAY: null
};
