/**
 * 成本核算
 * 目的不是精确到分，而是「能算出一个数量级正确的账单」，
 * 用来做日预算熔断与成本报表。真实账单以云厂商为准。
 */

const config = require('../../core/config');

/**
 * @param {object} usage {promptTokens, completionTokens}
 * @returns {{costYuan:number, costCents:number}}
 */
function calc(usage) {
  const p = (usage && usage.promptTokens) || 0;
  const c = (usage && usage.completionTokens) || 0;
  const yuan =
    (p / 1000) * config.llm.priceInPerK + (c / 1000) * config.llm.priceOutPerK;
  return {
    costYuan: +yuan.toFixed(6),
    costCents: +(yuan * 100).toFixed(4)
  };
}

/** 预估一次调用的成本（调用前判断预算是否够） */
function estimate(inputTokens, outputTokens) {
  return calc({ promptTokens: inputTokens, completionTokens: outputTokens });
}

module.exports = { calc, estimate };
