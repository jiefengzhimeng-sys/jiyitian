/**
 * OpenAI 兼容协议 Provider
 *
 * 为什么选这套协议作为唯一实现：
 *   混元、DeepSeek、豆包、Moonshot、通义、自建 vLLM 都提供 /v1/chat/completions，
 *   换供应商只需要改 baseUrl + model + key，代码零改动。
 *   比起为每家写一个 Provider，这是维护成本最低的做法。
 *
 * 为什么用 https 模块而不是全局 fetch：
 *   微信云函数的 Node 版本不固定（12/16/18 混用），Node 18 以下没有全局 fetch。
 *   自己用 https 写 30 行，比依赖运行时版本稳。
 */

const https = require('https');
const { URL } = require('url');

/** 底层 POST JSON */
function postJSON(urlString, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    let u;
    try {
      u = new URL(urlString);
    } catch (e) {
      return done(reject, new Error('LLM_BASE_URL 不是合法 URL: ' + urlString));
    }

    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          headers
        )
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => {
          raw += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            /* 非 JSON 响应，下面按原文返回 */
          }
          done(resolve, { status: res.statusCode, json, raw });
        });
      }
    );

    // 超时主动销毁：不销毁的话云函数会一直等到总超时，连降级的机会都没有
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('LLM_TIMEOUT'));
    });
    req.on('error', e => done(reject, e));
    req.write(payload);
    req.end();
  });
}

/** 可重试的判定：网络错误 / 超时 / 5xx / 429 */
function isRetryable(status, err) {
  if (err) {
    return /LLM_TIMEOUT|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message || '');
  }
  if (!status) return true;
  return status === 429 || status === 408 || status >= 500;
}

/**
 * 调用一次（含内部重试）
 * @param {object} opt {baseUrl, apiKey, model, timeoutMs, maxRetries, temperature, maxTokens, deadline}
 */
async function chat(opt) {
  const url = String(opt.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const started = Date.now();
  const deadline = opt.deadline || started + (opt.timeoutMs || 12000);
  const maxAttempts = 1 + Math.max(0, opt.maxRetries || 0);

  let lastReason = 'unknown';
  let lastMessage = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 每次尝试都用剩余预算，避免「重试一次直接把云函数拖超时」
    const remaining = deadline - Date.now();
    if (remaining < 1200) {
      lastReason = 'no_budget';
      break;
    }

    try {
      const res = await postJSON(
        url,
        {
          model: opt.model,
          temperature: opt.temperature,
          max_tokens: opt.maxTokens,
          messages: [
            { role: 'system', content: opt.system },
            { role: 'user', content: opt.user }
          ]
        },
        { Authorization: 'Bearer ' + opt.apiKey },
        Math.min(remaining, opt.timeoutMs || 12000)
      );

      if (res.status >= 200 && res.status < 300 && res.json) {
        const choice = (res.json.choices || [])[0] || {};
        const text = (choice.message && choice.message.content) || '';
        const usage = res.json.usage || {};
        return {
          ok: true,
          text,
          model: res.json.model || opt.model,
          usage: {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            estimated: !usage.prompt_tokens
          },
          latencyMs: Date.now() - started,
          attempts: attempt,
          finishReason: choice.finish_reason || ''
        };
      }

      lastReason = 'http_' + res.status;
      lastMessage = (res.json && (res.json.error && (res.json.error.message || res.json.error.code))) || String(res.raw || '').slice(0, 200);

      if (!isRetryable(res.status, null) || attempt === maxAttempts) break;
    } catch (e) {
      lastReason = /LLM_TIMEOUT/.test(e.message || '') ? 'timeout' : 'network';
      lastMessage = e.message;
      if (!isRetryable(0, e) || attempt === maxAttempts) break;
    }

    // 指数退避：400ms、800ms…，给上游一点恢复时间又不浪费预算
    const backoff = Math.min(2000, 400 * Math.pow(2, attempt - 1));
    if (Date.now() + backoff >= deadline) break;
    await new Promise(r => setTimeout(r, backoff));
  }

  return {
    ok: false,
    reason: lastReason,
    message: lastMessage,
    latencyMs: Date.now() - started,
    attempts: maxAttempts
  };
}

module.exports = { name: 'openai-compatible', chat, postJSON, isRetryable };
