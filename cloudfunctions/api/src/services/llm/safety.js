/**
 * 内容风控（技术文档 6.10 / PRD R10-08）
 *
 * 两类风险：
 *  ① 医疗越界：模型自由发挥给出「你可能抑郁了」「建议补充维生素 D」这类表述。
 *     健康类小程序这是审核红线，一旦出现在总结里，轻则驳回重则下架。
 *  ② 编造与极端表述：制造焦虑（「你的体重已经很危险」）、绝对化结论。
 *
 * 处理策略分三级，不是一刀切：
 *   block  → 整段不可用，必须重新生成（诊断、用药、疾病判断）
 *   soften → 可展示但需改写（绝对化、恐吓式表述）
 *   pass   → 放行
 */

// 命中即拦截：这些词一旦出现，属于明确的医疗行为
const BLOCK_PATTERNS = [
  { re: /(诊断|确诊|患有|得了).{0,6}(抑郁|焦虑症|厌食|暴食|糖尿病|高血压|贫血|甲亢)/, tag: 'disease' },
  { re: /(服用|吃|补充|加大|减少).{0,4}(药|药物|剂量|片|胶囊|补剂|维生素|褪黑素|益生菌)/, tag: 'medication' },
  { re: /(处方|用药|疗程|治疗方案|医嘱)/, tag: 'treatment' },
  { re: /(建议|应该|必须).{0,6}(就医|看医生|挂.{0,3}科|做.{0,4}检查)/, tag: 'medical_advice' },
  { re: /(BMI|体脂率).{0,6}(超标|过低|肥胖|不健康)/, tag: 'medical_index' },
  { re: /你可能(有|患)/, tag: 'diagnosis_hint' }
];

// 命中则改写：恐吓、绝对化、制造焦虑
const SOFTEN_PATTERNS = [
  { re: /(非常|极度|严重|十分)(危险|糟糕|不正常|不健康)/, tag: 'alarming', replace: '有些偏离你平时的节奏' },
  { re: /(必须|一定要|绝对)(立刻|马上|停止|戒掉)/, tag: 'absolute', replace: '可以试着' },
  { re: /(减肥|增重)(成功|失败)/, tag: 'judgement', replace: '体重变化' },
  { re: /你已经(胖|瘦)到/, tag: 'body_shame', replace: '体重现在是' }
];

/**
 * 扫描一段文本
 * @returns {{level:'pass'|'soften'|'block', hits:[], text:string}}
 */
function scan(text) {
  const s = String(text || '');
  const hits = [];

  for (const p of BLOCK_PATTERNS) {
    const m = s.match(p.re);
    if (m) hits.push({ level: 'block', tag: p.tag, match: m[0] });
  }
  if (hits.length) {
    return { level: 'block', hits, text: s };
  }

  let out = s;
  const softHits = [];
  for (const p of SOFTEN_PATTERNS) {
    const m = out.match(p.re);
    if (m) {
      softHits.push({ level: 'soften', tag: p.tag, match: m[0] });
      out = out.replace(p.re, p.replace);
    }
  }

  return {
    level: softHits.length ? 'soften' : 'pass',
    hits: softHits,
    text: out
  };
}

/** 扫描整份结构（标题 + 两段正文 + 建议），返回是否可用与清洗后的数据 */
function auditSummary(data) {
  if (!data) return { ok: false, level: 'block', hits: [{ tag: 'empty' }], data: null };

  const texts = [
    data.title,
    data.subtitle,
    data.review && data.review.text,
    data.trend && data.trend.text,
    (data.advice && data.advice.items || []).join('；')
  ].filter(Boolean);

  const allHits = [];
  let level = 'pass';

  texts.forEach(t => {
    const r = scan(t);
    if (r.level === 'block') level = 'block';
    else if (r.level === 'soften' && level === 'pass') level = 'soften';
    allHits.push(...r.hits);
  });

  if (level === 'block') {
    return { ok: false, level, hits: allHits, data: null };
  }

  // soften：把正文里的问题表述替换掉，其余保留
  const cleaned = Object.assign({}, data, {
    title: scan(data.title).text,
    subtitle: scan(data.subtitle).text,
    review: data.review ? Object.assign({}, data.review, { text: scan(data.review.text).text }) : data.review,
    trend: data.trend ? Object.assign({}, data.trend, { text: scan(data.trend.text).text }) : data.trend,
    advice: data.advice
      ? Object.assign({}, data.advice, { items: (data.advice.items || []).map(i => scan(i).text) })
      : data.advice
  });

  return { ok: true, level, hits: allHits, data: cleaned };
}

/** 免责声明：总结页固定展示，不依赖模型输出 */
const DISCLAIMER = 'AI 生成内容仅供参考，不构成任何医疗建议。身体不适请咨询专业医生。';

module.exports = { scan, auditSummary, DISCLAIMER, BLOCK_PATTERNS, SOFTEN_PATTERNS };
