/**
 * 结构化输出解析与校验
 *
 * 为什么不能直接 JSON.parse：
 *   即使加了「只输出 JSON」的硬约束，模型仍会：
 *   ① 包一层 ```json 代码块；② 前面加一句「好的，这是总结」；
 *   ③ 少写一个字段；④ 字数超标；⑤ advice.items 给 5 条。
 *   任何一条都会让前端渲染炸掉。所以这里做三件事：宽容解析 → 严格校验 → 归一化修复。
 *
 * 原则：能修就修（截断、补默认值），修不好才判失败，交给规则模板降级。
 */

const LIMITS = {
  titleMax: 24,
  subtitleMax: 32,
  reviewMin: 20,
  reviewMax: 200,
  trendMin: 20,
  trendMax: 240,
  adviceItems: 3,
  adviceItemMax: 48,
  tagsMax: 4,
  tagLenMax: 8
};

/** 宽容地抠出 JSON 对象 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;

  // ① 去掉 markdown 代码块围栏
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // ② 直接试一次
  try {
    return JSON.parse(s);
  } catch (e) {
    /* 继续尝试 */
  }

  // ③ 找第一个 { 到最后一个 } —— 处理前后有多余解释文字的情况
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = s.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch (e) {
      // ④ 常见问题：中文引号、尾逗号。做最小修复再试一次
      const fixed = sliced
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, '$1');
      try {
        return JSON.parse(fixed);
      } catch (e2) {
        return null;
      }
    }
  }
  return null;
}

const str = v => (typeof v === 'string' ? v.trim() : '');
const clip = (v, max) => {
  const s = str(v);
  return s.length > max ? s.slice(0, max) : s;
};

/**
 * 校验并归一化
 * @returns {{ok:boolean, data?:object, errors:string[]}}
 */
function validate(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['输出不是对象'] };
  }

  const title = clip(raw.title, LIMITS.titleMax);
  const subtitle = clip(raw.subtitle, LIMITS.subtitleMax);
  if (!title) errors.push('缺少 title');

  // review / trend 允许两种写法：对象 {text,highlights} 或纯字符串
  const pickSection = (v) => {
    if (typeof v === 'string') return { text: str(v), highlights: [] };
    if (v && typeof v === 'object') {
      return {
        text: str(v.text || v.content || ''),
        highlights: Array.isArray(v.highlights) ? v.highlights.map(x => clip(x, 40)).filter(Boolean).slice(0, 3) : []
      };
    }
    return { text: '', highlights: [] };
  };

  const review = pickSection(raw.review);
  const trend = pickSection(raw.trend);

  if (!review.text) errors.push('缺少 review.text');
  if (!trend.text) errors.push('缺少 trend.text');

  // advice：可能是 {text,items} 或直接数组
  let advice = { text: '', items: [] };
  if (Array.isArray(raw.advice)) {
    advice.items = raw.advice;
  } else if (raw.advice && typeof raw.advice === 'object') {
    advice.text = str(raw.advice.text);
    advice.items = Array.isArray(raw.advice.items) ? raw.advice.items : [];
  } else if (typeof raw.advice === 'string') {
    advice.text = str(raw.advice);
  }

  advice.items = advice.items
    .map(x => clip(x, LIMITS.adviceItemMax))
    .filter(Boolean)
    .slice(0, LIMITS.adviceItems);

  if (advice.items.length < LIMITS.adviceItems) {
    errors.push(`建议条数不足（${advice.items.length}/${LIMITS.adviceItems}）`);
  }

  let tags = Array.isArray(raw.tags) ? raw.tags : [];
  tags = tags.map(t => clip(t, LIMITS.tagLenMax)).filter(Boolean).slice(0, LIMITS.tagsMax);

  // 字数下限是软校验：太短说明模型敷衍，但短内容仍可展示，所以只记警告不判失败
  const warnings = [];
  if (review.text.length < LIMITS.reviewMin) warnings.push('review 偏短');
  if (trend.text.length < LIMITS.trendMin) warnings.push('trend 偏短');
  if (review.text.length > LIMITS.reviewMax) review.text = review.text.slice(0, LIMITS.reviewMax);
  if (trend.text.length > LIMITS.trendMax) trend.text = trend.text.slice(0, LIMITS.trendMax);

  // 只有「结构性缺失」才判失败：标题、两段正文；建议条数不足可降级展示
  const fatal = errors.filter(e => !e.startsWith('建议条数'));
  const usable = fatal.length === 0 && advice.items.length >= 1;

  return {
    ok: usable,
    errors,
    warnings,
    data: usable ? { title, subtitle, review, trend, advice, tags } : null
  };
}

/** 一步到位：原始文本 → 校验后的结构化对象 */
function parse(text) {
  const json = extractJSON(text);
  if (!json) return { ok: false, errors: ['无法解析出 JSON'], data: null };
  return validate(json);
}

module.exports = { LIMITS, extractJSON, validate, parse };
