/**
 * 规则模板总结生成器
 * 作用：LLM 未配置或调用失败时的降级方案，保证 AI 总结永不空白（对应 PRD R10-07）
 * 输入聚合数据，输出与 LLM 完全一致的结构，前端无感知
 */
const dateUtil = require('../utils/date');

function pct(n, total) {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

/**
 * @param {Object} p
 * @param {Array}  p.records  周期内记录
 * @param {Object} p.stats    聚合数据
 * @param {String} p.type     day | week | month
 * @param {String} p.periodKey
 */
function build(p) {
  const { records = [], stats = {}, type = 'week' } = p;
  const total = records.length;
  const typeName = type === 'day' ? '今天' : type === 'week' ? '这一周' : '这个月';

  const sport = records.filter(r => r.category === 'sport');
  const diet = records.filter(r => r.category === 'diet');
  const moodRecs = records.filter(r => !!r.mood);
  const voice = records.filter(r => r.type === 'voice');
  const image = records.filter(r => r.type === 'image' || (r.images && r.images.length));

  // —— 内容回顾 ——
  const parts = [];
  if (sport.length) parts.push(`运动 ${sport.length} 次`);
  if (diet.length) parts.push(`饮食记录 ${diet.length} 条`);
  if (voice.length) parts.push(`语音随笔 ${voice.length} 段`);
  if (image.length) parts.push(`照片 ${image.length} 组`);

  const moodTop = stats.moodTop;
  let reviewText = total
    ? `${typeName}共记录 ${total} 条（${parts.join('、') || '以文字为主'}）。`
    : '';
  if (moodTop) {
    reviewText += `情绪出现最多的是「${moodTop.name}」，占 ${moodTop.percent}%。`;
  }
  if (!total) {
    reviewText = `${typeName}记录较少，暂时还没有足够的线索。`;
  }

  // —— 趋势觉察 ——
  const trendLines = [];
  if (stats.weightDelta !== null && stats.weightDelta !== undefined) {
    const d = stats.weightDelta;
    if (Math.abs(d) < 0.2) {
      trendLines.push('体重基本持平，节奏很稳。');
    } else if (d < 0) {
      trendLines.push(`体重累计下降 ${Math.abs(d).toFixed(1)} kg，下降节奏${Math.abs(d) > 2 ? '偏快，注意别掉肌肉' : '健康'}。`);
    } else {
      trendLines.push(`体重上升 ${d.toFixed(1)} kg，可以回看这段时间的饮食记录找找原因。`);
    }
  }
  if (stats.sportDays !== undefined && stats.days) {
    trendLines.push(`有 ${stats.sportDays} 天记录了运动，占比 ${pct(stats.sportDays, stats.days)}%。`);
  }
  if (stats.lowAfterSedentary) {
    trendLines.push('几次情绪低落都出现在久坐之后，运动日的情绪明显更平稳。');
  }
  if (!trendLines.length) {
    trendLines.push('记录还不够密，多记几天就能看出规律了。');
  }

  // —— 轻量建议 ——
  const suggestions = [];
  if (sport.length < 3) suggestions.push('试试每周安排 3 次 20 分钟的快走，比一次练很猛更容易坚持');
  if (diet.length < 5) suggestions.push('每餐拍一张照片就够，不用写文字');
  if (moodRecs.length && stats.lowRatio > 0.3) suggestions.push('情绪偏低的日子，给自己留 10 分钟散步');
  suggestions.push('保持现在的记录节奏就好，不用加量');
  const sugText = suggestions.slice(0, 3).map((s, i) => `${['①', '②', '③'][i]} ${s}；`).join('').replace(/；$/, '');

  return {
    type,
    periodKey: p.periodKey,
    generatedBy: 'rule',
    title:
      type === 'day'
        ? total
          ? '今天这一页，记满了。'
          : '今天是空白页。'
        : total
        ? `这${type === 'week' ? '一周' : '个月'}，你${stats.lowRatio > 0.35 ? '有点累' : '稳了一点'}。`
        : '还没有足够的记录。',
    subtitle: `${total} 条记录 · ${stats.sportDays || 0} 天有运动`,
    blocks: [
      { key: 'review', label: '内容回顾', text: reviewText },
      { key: 'trend', label: '趋势觉察', text: trendLines.join('') },
      { key: 'suggest', label: '试试这三件小事', text: sugText }
    ],
    tags: ['📉 体重曲线', '🎭 情绪趋势', '🍽️ 饮食频次'],
    // 与云端 llm.DISCLAIMER 同一句话：免责声明是 PRD R10-08 的硬要求，
    // 降级模板也必须带，否则 Mock 里看不出问题、上线才发现漏了
    disclaimer: 'AI 生成内容仅供参考，不构成任何医疗建议。身体不适请咨询专业医生。',
    createdAt: Date.now()
  };
}

module.exports = { build };
