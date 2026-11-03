/**
 * Mock Provider —— 本地开发 / 演示 / 断网环境用
 * 行为与真实 Provider 完全一致（同样的返回结构、同样的延迟），
 * 这样上层编排逻辑不需要为 Mock 写分支。
 *
 * 触发方式：LLM_PROVIDER=mock，或编译期注入 MOCK_LLM=1
 */

const TEMPLATES = {
  day: {
    title: '今天，你把节奏放慢了一点',
    subtitle: '记录 4 条，情绪比上午稳',
    review: {
      text: '今天记了 4 条：一次傍晚的散步、两餐记录，还有一段睡前语音。散步那条写得最长，能看出你当时状态不错。',
      highlights: ['傍晚散步', '睡前语音']
    },
    trend: {
      text: '体重和前两天基本持平，饮食记录比平时完整。唯一的变化在情绪：上午偏低落，下午转平静，和运动时间基本对得上。',
      highlights: []
    },
    advice: { text: '明天可以照这个节奏来', items: ['下午 4 点后安排 20 分钟快走', '午餐拍一张照片就够，不用写文字', '睡前那段语音可以留着，一周后回听会有新发现'] },
    tags: ['节奏稳', '情绪回升', '散步']
  },
  week: {
    title: '这一周，你比上周稳了一点',
    subtitle: '记录 18 条，运动 3 天，情绪低谷集中在周三',
    review: {
      text: '这周记了 18 条，比上周多 5 条。运动集中在周一、周四、周六，都是有记录的日子。饮食记录偏少，只有 4 条，基本都在晚餐。',
      highlights: ['周三记录最密', '周六补记了三天前的内容']
    },
    trend: {
      text: '体重从 63.2 降到 62.5，降幅 0.7 公斤，速度不算快，属于能维持的节奏。情绪有一条明显的曲线：周三最低，正好是没运动的那天；周四运动后回到平静。饮食记录少的日子，情绪波动反而更大。',
      highlights: []
    },
    advice: { text: '不用加量，调整结构就行', items: ['周三固定留 20 分钟散步，把低谷那天补上', '午餐只拍照片，降低记录成本', '睡前把当天最想记住的一件事写一句，比长篇更容易坚持'] },
    tags: ['体重下降', '情绪有节奏', '运动 3 天']
  },
  month: {
    title: '这个月，习惯开始成形了',
    subtitle: '记录 76 条，21 天有记录，体重下降 1.8 公斤',
    review: {
      text: '一个月记了 76 条，覆盖 21 天。上半月记录密度高，下半月有 6 天空档，集中在月末那周。运动以快走和徒手训练为主，饮食记录集中在晚餐。',
      highlights: ['月末有 6 天空档', '快走是主力项目']
    },
    trend: {
      text: '体重从 64.1 降到 62.3，下降 1.8 公斤，曲线是缓慢下行的，没有反弹。情绪整体以平静为主，占 52%；低落主要集中在记录中断的那几天之后，说明记录本身对你有稳定作用。运动天数和情绪评分呈正相关。',
      highlights: []
    },
    advice: { text: '下个月守住「不断档」比加量更重要', items: ['设一个 21:30 的提醒，哪怕只写一句也算', '把快走固定成每周一三五，减少决策成本', '每周日花 2 分钟看一次周总结，比月底回看更有效'] },
    tags: ['习惯成形', '体重缓降', '月末断档']
  }
};

/**
 * @param {object} opt {system, user, model, periodType}
 */
async function chat(opt) {
  const started = Date.now();
  // 模拟真实延迟，让降级与超时逻辑在本地也能被测到
  const delay = 120 + Math.floor(Math.random() * 180);
  await new Promise(r => setTimeout(r, delay));

  const tpl = TEMPLATES[opt.periodType] || TEMPLATES.week;
  const text = JSON.stringify(tpl);

  return {
    ok: true,
    text,
    model: 'mock-summary-v1',
    usage: {
      promptTokens: Math.round((opt.user || '').length / 2),
      completionTokens: 180,
      estimated: true
    },
    latencyMs: Date.now() - started,
    attempts: 1,
    finishReason: 'stop'
  };
}

module.exports = { name: 'mock', chat, TEMPLATES };
