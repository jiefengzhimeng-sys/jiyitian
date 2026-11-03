/**
 * 日志与耗时埋点
 * 云函数日志按行检索，所以统一输出单行 JSON，方便在控制台按 requestId / action 筛。
 * 注意：不要把 openid 全量写进日志，脱敏成前 6 位 + 后缀，能定位人又不留完整标识。
 */

const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// prod 只打 info 以上，dev 全打
const MIN = config.appEnv === 'prod' ? LEVELS.info : LEVELS.debug;

/** openid 脱敏：oXXXXX***abcd */
function mask(id) {
  if (!id || typeof id !== 'string') return '';
  if (id.length <= 8) return id.slice(0, 2) + '***';
  return id.slice(0, 6) + '***' + id.slice(-4);
}

function write(level, msg, fields) {
  if (LEVELS[level] < MIN) return;
  const line = {
    level,
    t: new Date().toISOString(),
    msg
  };
  if (fields) {
    Object.keys(fields).forEach(k => {
      const v = fields[k];
      if (v === undefined) return;
      // 统一脱敏敏感键
      if ((k === 'userId' || k === 'openid') && typeof v === 'string') line[k] = mask(v);
      else line[k] = v;
    });
  }
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

/** 计时器：把各阶段耗时收进一个对象，最后一次打出来 */
function timer() {
  const start = Date.now();
  const marks = {};
  return {
    mark(name) {
      marks[name] = Date.now() - start;
      return marks[name];
    },
    get elapsed() {
      return Date.now() - start;
    },
    get marks() {
      return marks;
    }
  };
}

module.exports = {
  mask,
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
  timer
};
