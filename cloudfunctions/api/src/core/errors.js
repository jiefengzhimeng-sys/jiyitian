/**
 * 错误码与业务异常
 * 约定：
 *  - 4xx 是调用方问题（参数/权限/频控），用户能看到具体提示
 *  - 5xx 是服务端问题，日志里留真相，前端只给通用文案
 *  - 每个错误码对应一句人话提示，前端可直接展示，不用自己拼文案
 */

const CODES = {
  OK: 0,
  BAD_PARAM: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_LARGE: 413,
  QUOTA_EXCEEDED: 429,
  INTERNAL: 500,
  LLM_UNAVAILABLE: 503
};

// 错误码 → 默认人话（前端兜底用）
const MESSAGES = {
  [CODES.BAD_PARAM]: '填写的内容有点问题，检查一下',
  [CODES.UNAUTHORIZED]: '没有拿到身份信息，重新进入小程序试试',
  [CODES.FORBIDDEN]: '没有权限做这个操作',
  [CODES.NOT_FOUND]: '内容不存在或已被删除',
  [CODES.CONFLICT]: '操作冲突，请重试',
  [CODES.TOO_LARGE]: '内容超出限制了',
  [CODES.QUOTA_EXCEEDED]: '今天用得太频繁了，明天再来',
  [CODES.INTERNAL]: '服务出了点问题，稍后再试',
  [CODES.LLM_UNAVAILABLE]: '智能总结暂时不可用'
};

class AppError extends Error {
  /**
   * @param {number} code 错误码
   * @param {string} message 给人看的提示（尽量具体，别写"系统错误"）
   * @param {object} meta 附加信息，只进日志不返回前端
   */
  constructor(code, message, meta) {
    super(message || MESSAGES[code] || '出错了');
    this.name = 'AppError';
    this.bizCode = code;
    this.meta = meta || null;
    // 标记为可预期的业务异常，入口处据此决定日志级别
    this.expected = true;
  }
}

const bad = (msg, meta) => new AppError(CODES.BAD_PARAM, msg, meta);
const unauthorized = (msg) => new AppError(CODES.UNAUTHORIZED, msg);
const forbidden = (msg) => new AppError(CODES.FORBIDDEN, msg);
const notFound = (msg) => new AppError(CODES.NOT_FOUND, msg);
const conflict = (msg) => new AppError(CODES.CONFLICT, msg);
const quota = (msg) => new AppError(CODES.QUOTA_EXCEEDED, msg);

/** 断言：不满足就抛业务异常。比到处写 if-throw 干净 */
function assert(cond, factory) {
  if (!cond) throw (typeof factory === 'function' ? factory() : factory);
}

module.exports = {
  CODES,
  MESSAGES,
  AppError,
  bad,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  quota,
  assert
};
