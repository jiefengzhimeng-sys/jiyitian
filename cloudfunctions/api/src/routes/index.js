/**
 * 路由表
 * 每个 action 只做三件事：取参数 → 调 service → 返回。
 * 业务逻辑一律不写在路由里，方便单测与拆分云函数时平移。
 */

const recordService = require('../services/recordService');
const statsService = require('../services/statsService');
const summaryService = require('../services/summaryService');
const usersDao = require('../dao/users');
const statsDao = require('../dao/userStats');
const remindersDao = require('../dao/reminders');
const llm = require('../services/llm');

/** 用户侧接口：ctx = { userId, payload } */
const routes = {
  /* ---------------- 用户 ---------------- */
  'user.init': async ctx => {
    await usersDao.ensure(ctx.userId);
    // 首次进入同时把 stats / reminders 建好，避免后续接口处处判空
    await statsDao.get(ctx.userId);
    await remindersDao.get(ctx.userId);
    const profile = await statsService.profile(ctx.userId);
    // openid 只在这里回给前端：小程序端要用它拼云存储路径（records/{openid}/…），
    // 其余接口一律不返回，避免 openid 散落到页面数据里被带出去
    return Object.assign({}, profile, { openid: ctx.userId });
  },

  'profile.get': async ctx => statsService.profile(ctx.userId),

  'profile.update': async ctx => statsService.updateProfile(ctx.userId, ctx.payload),

  /* ---------------- 记录 ---------------- */
  'record.create': async ctx => {
    const r = await recordService.create(ctx.userId, ctx.payload);
    return r.record;
  },

  'record.list': async ctx => recordService.list(ctx.userId, ctx.payload),

  'record.get': async ctx => recordService.detail(ctx.userId, ctx.payload.id),

  'record.remove': async ctx => recordService.remove(ctx.userId, ctx.payload.id),

  'record.today': async ctx => recordService.today(ctx.userId, ctx.payload.dayKey),

  /* ---------------- 统计与打卡 ---------------- */
  'stats.overview': async ctx => statsService.overview(ctx.userId, ctx.payload),

  'checkin.get': async ctx => statsService.checkin(ctx.userId),

  /* ---------------- AI 总结 ---------------- */
  'summary.get': async ctx => summaryService.get(ctx.userId, ctx.payload),

  'summary.generate': async ctx => summaryService.generate(ctx.userId, ctx.payload),

  /** 配置自检：前端设置页可用它显示"智能能力是否已开启" */
  'summary.capability': async () => llm.inspect()
};

module.exports = { routes };
