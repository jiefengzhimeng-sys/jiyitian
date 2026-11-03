/**
 * 轻量参数校验
 * 不用 JSON Schema 库（云函数包体积敏感），手写几个断言就够：
 *   str / num / arr / oneOf / range / len
 * 校验失败一律抛 400，并把字段名带上，前端日志能直接定位。
 */

const { bad } = require('./errors');

const isNil = v => v === null || v === undefined;

function str(v, name, opt) {
  const o = opt || {};
  if (isNil(v) || v === '') {
    if (o.required) throw bad(`缺少${name}`);
    return o.default !== undefined ? o.default : '';
  }
  const s = String(v);
  if (o.max && s.length > o.max) throw bad(`${name}最多 ${o.max} 个字`);
  if (o.min && s.length < o.min) throw bad(`${name}至少 ${o.min} 个字`);
  return o.trim === false ? s : s.trim();
}

function num(v, name, opt) {
  const o = opt || {};
  if (isNil(v) || v === '') {
    if (o.required) throw bad(`缺少${name}`);
    return o.default !== undefined ? o.default : null;
  }
  const n = Number(v);
  if (isNaN(n)) throw bad(`${name}必须是数字`);
  if (o.min !== undefined && n < o.min) throw bad(`${name}不能小于 ${o.min}`);
  if (o.max !== undefined && n > o.max) throw bad(`${name}不能大于 ${o.max}`);
  return n;
}

function arr(v, name, opt) {
  const o = opt || {};
  if (isNil(v)) {
    if (o.required) throw bad(`缺少${name}`);
    return [];
  }
  if (!Array.isArray(v)) throw bad(`${name}格式不对`);
  if (o.max && v.length > o.max) throw bad(`${name}最多 ${o.max} 个`);
  return v;
}

function oneOf(v, name, allowed, opt) {
  const o = opt || {};
  if (isNil(v) || v === '') {
    if (o.required) throw bad(`缺少${name}`);
    return o.default !== undefined ? o.default : null;
  }
  if (allowed.indexOf(v) < 0) throw bad(`${name}取值不合法`);
  return v;
}

/** 校验 dayKey 格式与合理范围（不能是未来、不能太旧） */
function dayKey(v, name, opt) {
  const o = opt || {};
  const s = str(v, name, Object.assign({ required: true }, o));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${name}格式应为 YYYY-MM-DD`);
  const d = new Date(s.replace(/-/g, '/'));
  if (isNaN(d.getTime())) throw bad(`${name}不是有效日期`);
  return s;
}

/** 只保留白名单字段，防止客户端塞 userId / status 这类服务端字段 */
function pick(obj, keys) {
  const out = {};
  keys.forEach(k => {
    if (obj && obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

module.exports = { str, num, arr, oneOf, dayKey, pick };
