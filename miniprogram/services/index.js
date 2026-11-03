/**
 * 数据访问统一出口
 * 切库只改 utils/config.js 的 USE_MOCK —— 页面代码不需要动一行
 *
 * 契约（mock / cloud 两套实现保持一致）：
 *   listRecords({dayKey,startDay,endDay,category,cursor,limit}) -> {list,hasMore,nextCursor}
 *   getRecord(id) -> record
 *   createRecord(payload) -> record
 *   removeRecord(id) -> {ok}
 *   getToday() -> {dayKey,records,stats}
 *   getStats({startDay,endDay}) -> stats
 *   getCheckin() -> {streak,longest,checkedDays,monthCount,badges}
 *   getProfile() -> profile
 *   updateProfile(patch) -> profile
 *   getSummary({type}) -> summary
 *   generateSummary({type}) -> summary
 */
const config = require('../utils/config');
const mockRepo = require('./mock-repository');
const cloudRepo = require('./cloud-repository');

const repo = config.USE_MOCK ? mockRepo : cloudRepo;

module.exports = repo;
module.exports.__mode = repo.name;
