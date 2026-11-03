/**
 * Prompt 构造与上下文压缩
 *
 * 设计要点（技术文档 6.4 / 6.5）：
 *  1. 上下文压缩：用户一个月的记录可能上百条，全塞进去既贵又稀释信号。
 *     策略是「按天抽样 + 只保留结构化事实 + 正文截断」，把输入稳定压在 1200 token 内。
 *  2. 三段式输出：内容回顾 / 趋势觉察 / 建议，和前端 UI 的卡片结构一一对应，
 *     避免让 LLM 自由发挥导致前端渲染不出来。
 *  3. 给基准对比：把「上周/上月」的数据一起给它，它才能说出「比上周稳了一点」
 *     这种有比较的洞察，而不是复述数字。
 *  4. 硬约束写在 system 里：禁止医疗诊断、禁止编造、字数限制。
 */

const MOOD_LABEL = {
  joy: '开心',
  calm: '平静',
  low: '低落',
  angry: '烦躁',
  anx: '焦虑',
  tired: '疲惫'
};

const TAG_LABEL = {
  sport: '运动',
  diet: '饮食',
  mood: '心情',
  weight: '体重',
  other: '其他'
};

const PERIOD_META = {
  day: {
    name: '今天',
    focus: '这一天的具体事件、身体状态与情绪起伏，重点是一次性的细节（吃了什么、做了什么运动、什么时候情绪变差）',
    suggestionStyle: '给 3 条明天就能做的小事，具体到「几点做什么」'
  },
  week: {
    name: '这一周',
    focus: '一周内的规律与节奏：运动频次是否稳定、饮食结构有没有偏、情绪有没有周期性低谷',
    suggestionStyle: '给 3 条下一周可执行的小调整，不要泛泛而谈'
  },
  month: {
    name: '这个月',
    focus: '一个月的趋势走向：体重曲线方向、情绪基调、习惯有没有真的养成，以及和上个月的对比',
    suggestionStyle: '给 3 条下个月的方向性建议，允许比周建议更宏观'
  }
};

const SYSTEM_PROMPT = [
  '你是一个生活记录 App 里的回顾助手。用户的记录来自日常打卡：运动、饮食、心情、体重。',
  '',
  '你的任务：读懂这些记录，写一段让用户觉得「被看见」的回顾，而不是罗列数据。',
  '',
  '写作要求：',
  '1. 用第二人称「你」，语气克制、具体、不说教。像朋友翻完你的本子后说的话。',
  '2. 洞察必须基于数据。可以说「这周有 3 天在 22 点后记饮食，那几天心情都偏低」，',
  '   但不能编造数据里没有的事实。',
  '3. 有对比就说对比（和上周、和月均），没有对比就只说本周期。',
  '4. 建议要小到可以立刻执行，禁止「保持良好习惯」「注意饮食健康」这类空话。',
  '',
  '硬约束（违反即视为无效输出）：',
  '- 禁止任何医疗诊断、疾病名称判断、用药或补剂建议、治疗方案。',
  '- 禁止对体重变化给出「是否健康/是否达标」的医学结论，只描述趋势。',
  '- 禁止提及你是 AI 模型或被训练的方式。',
  '- 禁止输出 Markdown、代码块或 JSON 以外的任何内容。',
  '',
  '输出格式：严格 JSON，不要包裹 ```json，不要任何前后缀文字。',
  '{"title":"≤18字，有情绪但不夸张，可以不完整成句",',
  ' "subtitle":"≤24字，一句话概括最重要的结论",',
  ' "review":{"text":"内容回顾，60-110字","highlights":["一个具体细节","另一个细节"]},',
  ' "trend":{"text":"趋势觉察，80-130字，必须点出体重/饮食/情绪的变化及可能的关联"},',
  ' "advice":{"text":"总述，≤40字","items":["建议1","建议2","建议3"]},',
  ' "tags":["≤6字的短标签","..."]}'
].join('\n');

/**
 * 把记录压成紧凑的事实表
 * 压缩比例：一条记录从 ~80 token 降到 ~15 token
 */
function compressRecords(records, maxDays) {
  const limit = maxDays || 7;
  const byDate = {};

  (records || []).forEach(r => {
    const d = r.recordDate;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(r);
  });

  const dates = Object.keys(byDate).sort();
  // 天数超限时均匀抽样，保留首尾（用户最可能关心最近和开始）
  let picked = dates;
  if (dates.length > limit) {
    const step = dates.length / limit;
    picked = [];
    for (let i = 0; i < limit; i++) picked.push(dates[Math.min(dates.length - 1, Math.round(i * step))]);
    picked[picked.length - 1] = dates[dates.length - 1];
    picked = Array.from(new Set(picked));
  }

  return picked.map(d => {
    const rows = byDate[d];
    const tags = Array.from(new Set(rows.map(r => TAG_LABEL[r.tag] || r.tag)));
    const moods = rows.filter(r => r.mood).map(r => MOOD_LABEL[r.mood] || r.mood);
    const weights = rows
      .map(r => (r.detail && r.detail.weight) || null)
      .filter(w => typeof w === 'number');
    const notes = rows
      .map(r => (r.content || '').trim())
      .filter(Boolean)
      .slice(0, 2)
      .map(t => (t.length > 40 ? t.slice(0, 40) + '…' : t));

    return {
      date: d,
      tags,
      moods,
      weight: weights.length ? weights[weights.length - 1] : undefined,
      notes: notes.length ? notes : undefined,
      count: rows.length
    };
  });
}

/**
 * 构造 messages
 * @param {object} p {periodType, periodLabel, stats, records, baseline}
 */
function buildMessages(p) {
  const meta = PERIOD_META[p.periodType] || PERIOD_META.week;
  const days = compressRecords(p.records, p.periodType === 'month' ? 10 : p.periodType === 'week' ? 7 : 1);

  const facts = {
    周期: `${p.periodLabel || meta.name}（${p.stats.startDay} 至 ${p.stats.endDay}，共 ${p.stats.days} 天）`,
    记录总数: p.stats.totalRecords,
    有记录的天数: days.length,
    运动: { 次数: p.stats.sportCount, 天数: p.stats.sportDays },
    饮食记录: p.stats.dietCount,
    语音条数: p.stats.voiceCount,
    图片条数: p.stats.imageCount,
    体重: {
      当前: p.stats.weightCurrent,
      变化: p.stats.weightDelta,
      测量次数: p.stats.weightSeries ? p.stats.weightSeries.length : 0
    },
    情绪分布: (p.stats.moodDist || []).map(m => `${m.name} ${m.percent}%（${m.count}次）`),
    每天记录条数: (p.stats.countByDay || []).map(d => `${d.dayKey.slice(5)}:${d.count}`)
  };

  if (p.baseline) {
    facts.对比上期 = {
      记录数: { 本期: p.stats.totalRecords, 上期: p.baseline.totalRecords },
      运动次数: { 本期: p.stats.sportCount, 上期: p.baseline.sportCount },
      心情主调: { 本期: p.stats.moodTop && p.stats.moodTop.name, 上期: p.baseline.moodTop && p.baseline.moodTop.name },
      体重变化: { 本期: p.stats.weightDelta, 上期: p.baseline.weightDelta }
    };
  }

  const userMsg = [
    `这是用户${meta.name}的记录数据：`,
    JSON.stringify(facts, null, 1),
    '',
    '每天的原始记录（已裁剪）：',
    JSON.stringify(days, null, 1),
    '',
    `这一期要特别关注：${meta.focus}。`,
    meta.suggestionStyle + '。',
    '',
    '请按要求输出 JSON。'
  ].join('\n');

  return {
    system: SYSTEM_PROMPT,
    user: userMsg,
    // 粗略 token 估算：中文按 1 字 1 token，英文/符号按 4 字符 1 token
    estimatedTokens: estimateTokens(SYSTEM_PROMPT + userMsg)
  };
}

/** 中文为主的粗略估算，误差 ±20%，仅用于预算控制，最终以 API 返回 usage 为准 */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = s.length - cjk;
  return Math.round(cjk * 1 + rest / 4);
}

module.exports = {
  MOOD_LABEL,
  TAG_LABEL,
  PERIOD_META,
  SYSTEM_PROMPT,
  compressRecords,
  buildMessages,
  estimateTokens
};
