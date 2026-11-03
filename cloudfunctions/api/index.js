/**
 * 云函数 api 入口
 *
 * 一条请求的完整链路：
 *   解析 action → 身份识别 → 内部动作校验 → 路由分发 → 统一响应 → 结构化日志
 *
 * 设计取舍：所有接口收在一个云函数里（单体路由）。
 *   理由：MVP 阶段冷启动次数可控、部署一份配置、日志集中；
 *   每个 action 是独立 handler，将来要拆成独立云函数时按 handler 平移即可。
 *
 * 响应约定（与小程序 cloud-repository 契约一致）：
 *   成功：{ code: 0, data: <payload> }
 *   失败：{ code: 4xx/5xx, message: "给人看的中文提示" }
 */

const cloud = require('wx-server-sdk');
const { routes } = require('./src/routes');
const { adminActions, verify } = require('./src/routes/admin');
const { CODES, MESSAGES, AppError } = require('./src/core/errors');
const logger = require('./src/core/logger');
const config = require('./src/core/config');

const ok = data => ({ code: CODES.OK, data: data === undefined ? null : data });
const fail = (code, message) => ({ code, message });

/** 取调用者身份。云函数被小程序调用时一定有 OPENID；定时任务触发时为空 */
function resolveUserId() {
  try {
    const ctx = cloud.getWXContext();
    return (ctx && ctx.OPENID) || '';
  } catch (e) {
    return '';
  }
}

/** 统一错误响应：业务异常给具体文案，未知异常给通用文案 + 日志留真相 */
function toErrorResponse(e, action, requestId) {
  if (e instanceof AppError) {
    // 预期内的业务异常，info 级别即可
    logger.info('业务异常', { action, requestId, code: e.bizCode, message: e.message });
    return fail(e.bizCode, e.message);
  }
  logger.error('未捕获异常', {
    action,
    requestId,
    message: e && e.message,
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : ''
  });
  return fail(CODES.INTERNAL, MESSAGES[CODES.INTERNAL]);
}

exports.main = async (event, context) => {
  const started = Date.now();
  const action = (event && event.action) || '';
  const payload = (event && (event.payload || event.data)) || {};
  const requestId = (context && context.request_id) || '';

  if (!action) {
    return fail(CODES.BAD_PARAM, '缺少 action');
  }

  /* ---------------- 内部动作：定时任务 / 运维脚本 ---------------- */
  if (action.indexOf('admin.') === 0) {
    if (!verify(event.token)) {
      logger.warn('内部动作鉴权失败', { action, requestId });
      return fail(CODES.FORBIDDEN, '没有权限执行内部动作');
    }
    const handler = adminActions[action];
    if (!handler) return fail(CODES.NOT_FOUND, '未知的内部动作：' + action);
    try {
      const data = await handler(payload);
      logger.info('内部动作完成', { action, requestId, ms: Date.now() - started });
      return ok(data);
    } catch (e) {
      return toErrorResponse(e, action, requestId);
    }
  }

  /* ---------------- 用户动作 ---------------- */
  const handler = routes[action];
  if (!handler) {
    logger.warn('未知 action', { action, requestId });
    return fail(CODES.NOT_FOUND, '未知的接口：' + action);
  }

  const userId = resolveUserId();
  if (!userId) {
    return fail(CODES.UNAUTHORIZED, MESSAGES[CODES.UNAUTHORIZED]);
  }

  try {
    const data = await handler({ userId, payload, event, context });
    const ms = Date.now() - started;
    // 慢请求单独告警：>800ms 说明有性能问题，需要看是不是没走聚合
    if (ms > 800) {
      logger.warn('慢请求', { action, requestId, userId, ms });
    } else {
      logger.debug('请求完成', { action, requestId, userId, ms });
    }
    // 内部动作以外的返回值统一包一层，避免 service 直接返回裸数据被改坏
    return ok(data === undefined ? null : data);
  } catch (e) {
    return toErrorResponse(e, action, requestId);
  }
};

// 供本地单测直接引用（云函数运行时不会用到）
exports.__internals = { resolveUserId, config };
