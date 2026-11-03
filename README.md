# 记一天 · 微信小程序

一个只给自己看的生活记录本。运动、饮食、心情、体重随手记一笔，AI 帮你看出变化。

- 技术栈：微信原生 + 云开发（云函数 `api` 单体路由 + 云数据库 + 云存储）
- 视觉：纸上手账（纸底 `#FAF6EF` / 墨 `#17161A` / 青柠 `#D8F45C`），对应 UI 原型 V2
- 当前状态：**Mock 模式可直接跑通全部界面**，切一行配置即连真实云存储

---

## 一、5 分钟跑起来（Mock 模式，不需要云开发）

1. 微信开发者工具 → 导入项目 → 选择本目录（`jiyitian`）
2. AppID 选「测试号」即可（`project.config.json` 里是 `touristappid`）
3. 直接编译

此时 `miniprogram/utils/config.js` 的 `USE_MOCK: true`，数据走本地 Mock 仓储：

- 首次进入自动写入 20 条示例记录（`services/mock-repository.js` 的 `buildSeed`）
- 数据持久化在 `wx.setStorageSync`，不是内存假数据：新增/删除/翻页/打卡都真实生效
- 图片/语音在 Mock 下直接存本地临时路径，不产生任何网络请求
- 想恢复初始数据：我的 → 重置演示数据

---

## 二、切到真实存储（7 步，约 30 分钟）

### 1. 建云开发环境

开发者工具 → 云开发 → 开通 → 记下环境 ID（形如 `jiyitian-3g0xxx`）。

### 2. 填配置

`miniprogram/utils/config.js`：

```js
USE_MOCK: false,          // 关掉 Mock
CLOUD_ENV_ID: '你的环境ID' // 留空则用默认环境，但多环境时一定要填
```

同时把 `project.config.json` 的 `appid` 换成你自己的小程序 AppID（云开发必须要真实 AppID）。

### 3. 建 9 个集合

云开发控制台 → 数据库 → 新建集合，权限全部选**「仅创建者可读写」**：

| 集合 | `_id` 规则 | 用途 |
|---|---|---|
| `users` | userId | 用户档案与设置（`settings` 对象存开关） |
| `records` | 自动 | 记录主表：`tag` / `mood` / `detail.weight` / `mediaSnap` / `status` |
| `media_assets` | 自动 | 图片与语音资产：配额统计、审核状态、清理 |
| `daily_aggs` | `{userId}_{YYYY-MM-DD}` | 按天聚合（读统计只点查这张） |
| `user_stats` | userId | streak / 累计条数 / 徽章 |
| `ai_summaries` | `{userId}_{type}_{periodKey}` | AI 总结（含 chartData 与成本） |
| `ai_quota` | `{userId}_{date}_{type}` | 频控与成本账本 |
| `reminders` | userId | 提醒设置与订阅消息剩余额度 |
| `audit_logs` | 自动 | 风控与敏感操作审计 |

> 确定性 `_id` 的好处：`daily_aggs` 一天一条、`ai_summaries` 一周期一条，重复写入只会 update 同一条，天然去重，不需要「先查再写」也就没有并发竞态。

> 完整的字段定义、状态机与一致性策略见 **[cloudfunctions/api/README.md](cloudfunctions/api/README.md)**。

### 4. 建索引（性能命门，别省）

微信云开发不支持用 SDK 建索引，必须在控制台手工添加。最小必配 4 条（完整清单见 `cloudfunctions/api/scripts/indexes.json`）：

| 集合 | 索引字段 | 支撑查询 |
|---|---|---|
| `records` | `userId`(升) + `recordDate`(降) + `createdAt`(降) | 时间线、首页、游标分页 |
| `records` | `userId`(升) + `status`(升) + `recordDate`(降) | 所有带状态过滤的查询 |
| `records` | `idempotencyKey`（**唯一**） | 防重复提交 |
| `daily_aggs` | `userId`(升) + `date`(降) | 统计、streak、打卡月历 |

> 漏配的后果：开发期 20 条数据看不出差别，上线后时间线从 10ms 变成全表扫描数秒。

### 5. 部署两个云函数

```bash
右键 cloudfunctions/api        → 上传并部署：云端安装依赖
右键 cloudfunctions/timerDaily → 上传并部署
```

`timerDaily` 只做调度，业务逻辑全在 `api` 里（云函数目录隔离打包，复制一份逻辑迟早不一致）。它的 `config.json` 带两个触发器：

```json
{
  "permissions": { "openapi": ["subscribeMessage.send"] },
  "triggers": [
    { "name": "dailyTimer",  "type": "timer", "config": "0 10 0 * * * *" },
    { "name": "remindTimer", "type": "timer", "config": "0 */30 * * * * *" }
  ]
}
```

> 用户量上千后，把 `timerDaily` 的超时从默认 20s 调到 60s，否则处理不完一批用户（它会在 `report.partial` 里告诉你没跑完）。

### 6. 配置环境变量

云函数 `api` → 配置 → 环境变量。**不配也能跑**，代码对每个变量都有默认值与降级路径。

至少配这两个（生产必配）：

| 变量 | 示例 | 说明 |
|---|---|---|
| `APP_ENV` | `prod` | prod 下未配 token 的内部动作直接拒绝 |
| `INTERNAL_TOKEN` | 随机 32 位 | 定时任务与运维脚本的口令 |

大模型（不配就走规则模板，AI 总结永远不空白）：

| 变量 | 示例 | 说明 |
|---|---|---|
| `LLM_API_KEY` | `sk-xxx` | 密钥只放云端环境变量，**绝不进前端代码** |
| `LLM_BASE_URL` | `https://api.hunyuan.cloud.tencent.com/v1` | OpenAI 兼容端点 |
| `LLM_MODEL` | `hunyuan-lite` | 模型名 |
| `LLM_DAILY_BUDGET_CENTS` | `500` | 全局日预算（分），超了自动降级 |

换供应商只改 baseUrl + model 两行（混元 / DeepSeek / 豆包 / Moonshot / 自建 vLLM 都走同一协议）。完整变量表见后端 README。

部署后先跑两个自检：

```json
{ "action": "admin.dbCheck",    "token": "..." }
{ "action": "admin.llmInspect", "payload": { "probe": true }, "token": "..." }
```

### 7. 打开隐私配置

小程序后台 → 设置 → 服务内容声明 → **用户隐私保护指引**，勾选并说明：

- 相册/相机（拍摄饮食照片）
- 麦克风（录制语音随笔）
- 你的主动填写内容（文字、体重、心情）

不配这一项，`wx.chooseMedia` 和录音会在真机上直接失败（对应错误对照 E-06）。

---

## 三、目录结构

```
jiyitian/
├── project.config.json
├── miniprogram/
│   ├── app.js / app.json / app.wxss      全局入口、分包、设计令牌（CSS 变量）
│   ├── custom-tab-bar/                   自定义 tabBar（中间青柠方块 → navigateTo 记录页）
│   ├── pages/
│   │   ├── home/                         首页：情绪天气卡 + 快捷入口 + 今日记录流
│   │   ├── record/                       记录创建：文字 / 语音 / 图片 + 情绪 + 体重
│   │   ├── timeline/                     时间线：日/周/月 + 分类筛选 + 游标分页
│   │   ├── stats/                        数据：体重折线 + 情绪环形 + 饮食柱状
│   │   └── profile/                      我的：统计 + 设置开关 + 演示数据重置
│   ├── pkgA/                             分包（首页进入时预下载）
│   │   ├── summary/                      AI 日/周/月总结（刊物封面式版式）
│   │   ├── checkin/                      打卡：点阵月历 + streak + 徽章
│   │   ├── detail/                       记录详情（缩略图内联 / 点击看原图）
│   │   └── settings/                     设置：通知、隐私、缓存、环境自检
│   ├── components/
│   │   ├── nav-bar/                      自定义导航（适配状态栏）
│   │   ├── chart/                        Canvas 2D 图表：line / ring / bar，零依赖
│   │   ├── mood-picker/                  情绪六档选择器
│   │   ├── record-card/                  记录卡片（feed / timeline 两态）
│   │   ├── empty-state/                  空状态（写人话，不写「暂无数据」）
│   │   └── skeleton/                     骨架屏
│   ├── services/
│   │   ├── index.js                      仓储统一出口（切库只改 config）
│   │   ├── mock-repository.js            Mock 实现：持久化 + 分页 + 聚合
│   │   ├── cloud-repository.js           云端实现：走 api 云函数
│   │   ├── media.js                      图片压缩 / 上传 / 临时链接
│   │   └── summary-template.js           规则模板总结（LLM 降级用）
│   └── utils/
│       ├── config.js                     运行配置（USE_MOCK / 限额 / 图片规格）
│       ├── constants.js                  分类、情绪、记录类型、tabBar
│       ├── date.js                       dayKey 时间主轴
│       └── feedback.js                   toast / loading / confirm 统一封装
└── cloudfunctions/
    ├── api/                              业务云函数（分层：core / dao / domain / services / routes）
    │   ├── index.js                      入口：身份识别 → 内部鉴权 → 路由 → 统一响应 → 日志
    │   ├── src/                          13 个对外动作 + 8 个内部动作
    │   ├── scripts/local-test.js         本地端到端测试（53 项断言，不需要云环境）
    │   └── README.md                     后端文档：环境变量 / 接口 / 索引 / 大模型 / 运维
    └── timerDaily/                       调度器：分批调 api 内部动作，不复制业务逻辑
```

---

## 四、Mock / 真实存储双轨怎么做到零改动

核心只有一个文件：`services/index.js`

```js
const repo = config.USE_MOCK ? mockRepo : cloudRepo;
module.exports = repo;
```

两个实现遵守**完全相同的 11 个方法契约**（`listRecords` / `createRecord` / `getStats` / `getCheckin` /
`getSummary` / `generateSummary` …）。所以：

- 第 1 周纯 Mock 跑 UI 与交互，不依赖任何后端
- 第 2 周切 `USE_MOCK: false` 联调，**页面代码一行不改**（`git diff pages/` 应该为空）

Mock 不是摆设，它实现了：真实持久化、游标分页、跨页合并、聚合计算、模拟延迟、
业务校验抛错（空内容、体重越界），所以联调时暴露的问题基本都是后端问题，不会互相甩锅。

---

## 五、性能方案落地情况

| 技术文档里的方案 | 代码里的位置 | 状态 |
|---|---|---|
| 写时算、读时取（日聚合） | `api` 的 `bumpDaily` / `dropDaily`，记录增删时 O(1) 增量更新 | ✅ |
| 游标分页，不用 skip | `record.list` 用 `(recordDate, createdAt)` 复合游标；服务端生成单调递增的 `createdAt`，避免同毫秒记录被游标漏掉 | ✅ |
| streak 定时重算，不实时扫表 | `timerDaily` 每天 00:10 重算，只取近 120 天 | ✅ |
| 体重曲线只取必要字段 | `stats.overview` 用 `.field({dayKey,weight,createdAt})` | ✅ |
| 一份原图 + 三档规格 | `media.uploadImage` 上传 thumb + origin；详情页内联 thumb、点开 origin | ✅ |
| 上传前两道压缩 | `chooseMedia(compressed)` + `media.normalize` 长边 2000 二次压缩 | ✅ |
| 分包 + 预下载 | `app.json` 的 `subpackages` + `preloadRule` | ✅ |
| 按月归档 / MySQL 迁移 | 预留 Repository 抽象，时机到了只换实现 | ⏳ 待数据量触发 |

**小图 / 原图的具体做法**：列表与详情内联用 `thumbs`（压缩后 ≤1080px，单张约 15-35KB），
`wx.previewImage` 传入 `origins`（原图）才加载大图。用户放大看的是清晰原图，列表流量降 90%。

---

## 六、已知边界（MVP 有意为之，别当 Bug）

1. **图片一律存 fileID，不存临时链接**：记录里存 `cloud://` fileID，`image` 组件直连渲染；
   只有详情页预览、语音播放这类需要 https 的场景才在**读取时**换临时链接（`media.resolveTempURL`）。
   早期版本把 `tempFileURL` 直接落库，2 小时后列表整片裂图 —— 联调时已改掉。
2. **AI 总结在 Mock 下是规则模板**：`generatedBy: 'rule'`。接 LLM 后自动变 `'llm'`。
3. **订阅消息未接**：提醒开关只保存设置，真正推送需要在小程序后台申请模板 ID 并调 `wx.requestSubscribeMessage`。
4. **回收站只有 30 天软删逻辑**，没有恢复入口（V1.1）。
5. **点数上限**：`timerDaily` 单次最多处理 5000 用户，超出需分片或改架构。
6. **同一毫秒跨实例写入仍可能撞点**：`createdAt` 的单调性靠单实例内计数器保证。用户在两台设备
   同毫秒各写一条是极小概率事件，前端 `mergeGroups` 已按 `_id` 去重兜底（宁可重复一条，不能丢）。
   若将来做批量导入，升级路径是游标再加 `_id` 三元组并补一条含 `_id` 的复合索引。

---

## 七、提审前检查清单

- [ ] `USE_MOCK` 已改为 `false`，`CLOUD_ENV_ID` 是**正式环境**（不是测试环境，见 E-12）
- [ ] `project.config.json` 的 appid 是正式 AppID，与后端环境一致
- [ ] 服务类目：工具 / 健康管理（以微信官方最新类目要求为准，涉及健康需核对是否需要资质）
- [ ] 用户隐私保护指引已配置并生效（相册、麦克风、主动填写内容）
- [ ] 设置页的「隐私保护指引」「用户协议」入口可点开、内容真实
- [ ] AI 总结页固定展示「仅供参考，不构成医疗建议」（`summary.wxml` 已内置）
- [ ] 各页面空态、加载态、错误兜底齐全，无「暂无数据」式冷文案
- [ ] 真机走一遍：选图 → 压缩 → 保存 → 时间线 → 详情看原图 → 删除
- [ ] 云函数日志里无持续报错，`timerDaily` 手动测试执行一次成功

---

## 八、常用调试入口

- 重置演示数据：我的 → 重置演示数据（或 设置 → 重置演示数据）
- 看数据源与基础库版本：设置 → Diagnostics
- 强制刷新跨页数据：记录保存后会置 `app.globalData.needRefresh`，首页/时间线/统计 `onShow` 消费一次
- 清缓存：设置 → 清理缓存（保留业务数据，只清临时 key）

---

## 九、前后端联调（不用开微信开发者工具）

三套本地测试，全部不需要云环境、不需要网络：

```bash
# 以下命令都在 jiyitian 目录下执行

# ① 后端单测：直接调云函数 action，覆盖校验/越权/幂等/配额/降级/对账
(cd cloudfunctions/api && node scripts/local-test.js)     # 55 项

# ② 前后端联调：真页面 → 真云函数 → 内存数据库（用完即弃，不碰云环境）
node scripts/integration/e2e.js                           # 32 项

# ③ Mock 链路冒烟：保证 USE_MOCK 开关两边都能跑
node scripts/integration/mock-smoke.js                    # 10 项
```

②的做法值得单独说：`scripts/integration/mini-runtime.js` 造了一个极简小程序运行时
（`wx` / `Page` / `App` / `setData` / 录音 / 选图 / 云存储），然后：

```
真实页面 .js  →  services/cloud-repository  →  wx.cloud.callFunction
             →  api.main  →  service  →  dao  →  内存数据库
```

链路里**没有一行 mock 的业务代码**，只有「微信客户端」和「云数据库」两层是假的。
所以页面用错字段、接口少了返回、前后端口径不一致，这里都会直接红。

联调一次性揪出并修掉的问题（详见 `docs/前后端联调报告.md`）：

| 问题 | 后果 |
|---|---|
| `user.init` 不返回 `openid` | 前端拿不到 openid，云存储路径拼成 `records//…` |
| 缩略图把 `tempFileURL` 落库 | 2 小时后列表缩略图整片裂图 |
| 草稿恢复覆盖入口参数 | 首页点「拍照」进去却是上次的文字草稿 |
| 补记更早日期不重算 streak | 连续天数一直显示偏小，直到下次记今天才修正 |
| 游标同毫秒撞点 | 16 条记录翻页只翻出 13 条，静默丢数据 |
| 总结页缺「未生成」空态 | 云端首次进入渲染成一个空封面 |
| 前端口径用「近 7 天」、后端用「本周」 | 总结正文说的周期和曲线画的区间不是同一段 |
| `reminders.save` 写入 `undefined` | `remindOn: true` 的扫描条件永远命中不到 |

---

## 十、提审前检查清单
