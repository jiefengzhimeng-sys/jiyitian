# 后端说明 · 云函数 api

「记一天」的后端全部跑在微信云开发上：一个单体云函数 `api`（业务路由）+ 一个调度函数 `timerDaily`（定时任务）+ 云数据库 + 云存储。没有独立服务器，不需要运维机器。

```
cloudfunctions/
├── api/                    # 业务云函数（入口 index.js 只做路由与鉴权）
│   ├── index.js            # 入口：身份识别 → 内部鉴权 → 路由分发 → 统一响应 → 日志
│   ├── src/
│   │   ├── core/           # 地基：配置 / 数据库 / 错误码 / 日志 / 日期 / 校验
│   │   ├── dao/            # 数据访问：9 个集合各一个 DAO，只碰存储不碰业务
│   │   ├── domain/         # 领域模型：入参校验 + 存储结构 ↔ 前端 DTO 映射
│   │   ├── services/       # 业务逻辑：记录 / 统计 / 总结 / LLM 编排
│   │   └── routes/         # 路由表：13 个对外动作 + 8 个内部动作
│   └── scripts/            # 本地开发工具（不上生产也没影响，约 90KB）
└── timerDaily/             # 调度器：分批调 api 的内部动作，不复制业务逻辑
```

**为什么 timerDaily 不自己实现业务**：云函数目录是隔离打包的，`timerDaily` 无法 `require('../api/src')`。如果在这里复制一份聚合逻辑，改字段就要改两处，迟早不一致。所以它只做「扫用户 → 调 api → 汇总报告」。

---

## 一、环境变量（部署第一件事）

云开发控制台 → 云函数 → `api` → 配置 → 环境变量。**全部可以不配**，代码对每个变量都有默认值与降级路径。

### 必配（生产）

| 变量 | 说明 | 示例 |
|---|---|---|
| `APP_ENV` | `dev` / `prod`。prod 下只打 info 以上日志，未配 token 的内部动作直接拒绝 | `prod` |
| `INTERNAL_TOKEN` | 内部动作口令，定时任务与运维脚本用。**生产必须配置**，否则 `admin.*` 全部拒绝 | 随机 32 位字符串 |

### 大模型（不配就走规则模板，功能不空白）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | `auto` | `auto` 有 key 就调、没 key 走规则；`mock` 用内置假数据（本地演示）；`off` 完全不调（省钱/压测） |
| `LLM_BASE_URL` | 混元地址 | OpenAI 兼容端点，末尾不带 `/chat/completions` |
| `LLM_API_KEY` | 空 | 供应商 key |
| `LLM_MODEL` | `hunyuan-lite` | 模型名 |
| `LLM_TIMEOUT_MS` | `12000` | 单次超时。云函数总超时 20s，留 8s 给重试与落库 |
| `LLM_MAX_RETRIES` | `1` | 只对超时/5xx/429 重试，参数错误不重试（重试也没用，只烧钱） |
| `LLM_TEMPERATURE` | `0.6` | 风控重生成时会自动降到 0.3 |
| `LLM_MAX_TOKENS` | `700` | 输出上限 |
| `LLM_PRICE_IN_PER_K` | `0.0008` | 元/千 token，用于成本核算 |
| `LLM_PRICE_OUT_PER_K` | `0.002` | 同上 |
| `LLM_DAILY_BUDGET_CENTS` | `500` | 全局日预算（分）。超了自动降级规则模板，账单封顶 |

**换供应商只改三行**（都提供 OpenAI 兼容协议）：

```bash
# 混元
LLM_BASE_URL=https://api.hunyuan.cloud.tencent.com/v1
LLM_MODEL=hunyuan-lite

# DeepSeek
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat

# 豆包 / Moonshot / 自建 vLLM 同理
```

### 其它

| 变量 | 默认 | 说明 |
|---|---|---|
| `QUOTA_PER_PERIOD` | `1` | 每周期正式生成次数 |
| `QUOTA_RETRY` | `2` | 每周期手动重试额度（按天重置） |
| `QUOTA_USER_DAY` | `10` | 单用户单日总调用上限，兜异常刷接口 |
| `ARCHIVE_ENABLED` | `false` | 按月归档开关。**单集合超 2000 万文档再打开**，别提前优化 |
| `ARCHIVE_HOT_MONTHS` | `12` | 归档后主集合保留月数 |
| `SUBSCRIBE_TEMPLATE_ID` | 空 | 订阅消息模板 ID（`timerDaily` 用），空则跳过提醒 |

---

## 二、接口清单

### 对外（小程序调用，需微信身份）

| action | 入参 | 返回 | 说明 |
|---|---|---|---|
| `user.init` | — | profile | 首次进入建档（幂等），同时建 stats / reminders |
| `profile.get` | — | profile | 档案 + 累计统计 |
| `profile.update` | `{nickname, avatarEmoji, aiSummary, reminder, reminderTime}` | profile | 平铺字段写入 `settings` 对象 |
| `record.create` | 见下 | record DTO | 幂等 + 校验 + 聚合 + streak |
| `record.list` | `{dayKey,startDay,endDay,category,cursor,limit}` | `{list,hasMore,nextCursor}` | 复合游标分页 |
| `record.get` | `{id}` | record DTO | 越权与不存在都返回 404 |
| `record.remove` | `{id}` | `{ok,id}` | 软删进回收站 |
| `record.today` | `{dayKey}` | `{dayKey,records,stats}` | 首页一次拿全 |
| `stats.overview` | `{startDay,endDay}` | 统计对象 | 全走 daily_aggs |
| `checkin.get` | — | `{streak,longest,checkedDays,monthCount,badges}` | 打卡月历 |
| `summary.get` | `{type}` | 总结 or null | 读缓存，无则返回 null |
| `summary.generate` | `{type,force}` | 总结 | LLM 生成 + 四层降级 |
| `summary.capability` | — | `{provider,model,hasKey,...}` | 前端可显示「智能能力是否已开启」 |

`record.create` 入参（前端契约）：

```json
{
  "type": "text|voice|image|weight",
  "category": "sport|diet|mood|weight|other",
  "content": "≤500 字",
  "mood": "joy|calm|low|angry|anx|tired",
  "weight": 62.5,
  "images": ["cloud://原图 fileID"],
  "thumbs": ["cloud://缩略图 fileID"],
  "voice": { "fileID": "cloud://...", "duration": 42 },
  "dayKey": "2026-11-02"
}
```

### 内部（定时任务 / 运维，需 `INTERNAL_TOKEN`）

| action | 用途 |
|---|---|
| `admin.reconcileUser` | 重算某用户近 N 天聚合与 streak（对账修复） |
| `admin.genSummary` | 为某用户预生成指定周期总结 |
| `admin.purgeTrash` | 物理删除回收站到期记录 |
| `admin.cleanup` | 清理过期配额与审计日志 |
| `admin.trimSummaries` | 历史总结瘦身（删 chartData） |
| `admin.llmInspect` | LLM 配置与连通性自检（`probe:true` 会真打一次模型） |
| `admin.dbCheck` | 存储体检：集合计数 + 脏数据抽样 |
| `admin.batchStreak` | 批量重算 streak |

调用示例（云函数测试面板）：

```json
{ "action": "admin.llmInspect", "payload": { "probe": true }, "token": "你的 INTERNAL_TOKEN" }
```

---

## 三、数据存储

### 集合与关键字段

| 集合 | `_id` 规则 | 关键字段 |
|---|---|---|
| `users` | userId | `settings{remindOn,remindTime,aiSummaryOn}`, `status`, `schemaVer` |
| `records` | 自动 | `userId`, `content`, `tag`, `mood`, `detail.weight`, `mediaSnap[]`, `recordDate`, `status`, `idempotencyKey`, `deletedAt`, `schemaVer` |
| `media_assets` | 自动 | `userId`, `recordId`, `type`, `fileID`, `size`, `width/height`, `duration`, `status` |
| `daily_aggs` | `{userId}_{YYYY-MM-DD}` | `recordCount`, `byTag{}`, `moodCounts{}`, `moodScoreSum`, `weight`, `mediaCount`, `voiceCount` |
| `user_stats` | userId | `streakCurrent`, `streakMax`, `lastRecordDate`, `totalRecords`, `badges` |
| `ai_summaries` | `{userId}_{periodType}_{periodKey}` | `content`, `chartData`, `status`, `generatedBy`, `tokens`, `costCents`, `fallbackReason` |
| `ai_quota` | `{userId}_{date}_{periodType}` | `count`, `retryCount`, `callCount`, `promptTokens`, `costCents` |
| `reminders` | userId | `remindOn`, `remindTime`, `quotaLeft`, `lastSentDate` |
| `audit_logs` | 自动 | `userId`, `action`, `result`, `reason`, `at` |

**确定性 _id 的价值**：`daily_aggs` 一天一条、`ai_summaries` 一周期一条。重复写入只会 update 同一条，天然去重，不需要「先查再写」也就没有并发竞态。

### 索引（性能命门）

微信云开发**不支持用 SDK 建索引**，必须在控制台按 `scripts/indexes.json` 手工添加。最小必配 4 条：

| 集合 | 索引 | 支撑 |
|---|---|---|
| `records` | `userId ↑ + recordDate ↓ + createdAt ↓` | 时间线、首页、分页 |
| `records` | `userId ↑ + status ↑ + recordDate ↓` | 所有带状态过滤的查询 |
| `records` | `idempotencyKey`（**唯一**） | 防重复提交 |
| `daily_aggs` | `userId ↑ + date ↓` | 统计、streak、月历 |

漏配的后果：开发期 20 条数据看不出差别，上线后时间线从 10ms 变成全表扫描数秒。

### 数据量上来了怎么办

三个不同问题，分开解：

1. **单用户几千条** → 查询永远带日期范围 + 游标分页（不用 skip），索引直取 20 条，稳定 10-30ms。
2. **单集合千万级** → 打开 `ARCHIVE_ENABLED`，按月写 `records_202611`，路由层按日期范围合并；先双写 → 回刷 → 灰度切读 → 下线旧数据。
3. **跨用户聚合** → 一律读 `daily_aggs` 或离线导出，线上库不做全表聚合。

### 一致性保障

| 冗余字段 | 更新时机 | 不一致时的修正 |
|---|---|---|
| `daily_aggs.recordCount` | 记录增删时 inc | `admin.reconcileUser` 按源数据重算 |
| `user_stats.streak*` | 写记录时 + 每日定时 | 同上（跨天必须重算，增量表达不了） |
| `user_stats.totalRecords` | 写入时 inc | 对账时用 count 校正 |

对账逻辑与增量更新是**两套独立实现**，故意不同源才能互相校验。建议上线后在数据看板加一个「聚合 vs 源数据」日对比，漂移 > 0.5% 告警。

---

## 四、大模型接入

### 调用链路

```
summaryService.generate
  → 周期计算 / 命中缓存则直接返回
  → 数据不足 3 条 → insufficient（不调 LLM）
  → 配额检查（正式次数 / 重试额度 / 单日上限）
  → 标记 generating（防并发重复调）
  → llm.generate
      → 日预算检查（超预算直接降级，账单封顶）
      → prompt.buildMessages（上下文压缩到 ~1200 token）
      → provider.chat（超时 + 重试，每次尝试用剩余预算）
      → schema.parse（宽容解析：去 fence、取第一个 {}、修中文引号与尾逗号）
      → safety.auditSummary（block 拦截 / soften 改写）
      → 成本记账
  → 组装前端结构 + 曲线数据 → 落库 → 审计
```

### 四层降级（这是「AI 挂了功能不空白」的全部实现）

| 层 | 触发 | 结果 |
|---|---|---|
| ① | 未配 key / `LLM_PROVIDER=off` | 直接走规则模板，不浪费时间 |
| ② | 超时 / 网络 / 5xx（已内置 1 次重试） | 降级规则模板，`fallbackReason=call_failed:*` |
| ③ | 输出结构不合格 | 降级规则模板，原始输出前 180 字进日志 |
| ④ | 内容风控拦截 | 追加更严格约束重生成 1 次，仍拦截则降级 |

`llm.generate` **永远不抛异常**，上层只看 `ok` 字段。所以云端不会因为模型故障返回 500 给用户。

### 内容风控（健康类目的审核红线）

- **block**（整段不可用）：疾病诊断、用药/补剂建议、就医指导、BMI 医学判断、「你可能有…」
- **soften**（替换表述后展示）：「非常危险」→「有些偏离你平时的节奏」、「必须立刻停止」→「可以试着」
- 免责声明固定展示，不依赖模型输出：`AI 生成内容仅供参考，不构成任何医疗建议。`

### 成本参考

1 万 DAU、人均 3 次总结/周：约 **80-600 元/月**（取决于供应商与模型档位）。真实账单以云厂商为准，代码里记的是 `tokens` 与 `costCents`，可导出核对。

---

## 五、本地测试

不需要云环境、不需要网络，`wx-server-sdk` 被替换成内存实现，跑的是**生产同一套代码**（路由 → service → dao → db）。

```bash
cd cloudfunctions/api
node scripts/local-test.js
```

当前覆盖 53 项断言：

- 建档幂等、四类记录创建、媒体快照双档
- 六条校验分支（空内容 / 超字数 / 体重越界 / 超 9 图 / 补记超期 / 未来日期）
- 幂等重复提交不产生第二条
- 越权读、越权删（都返回 404，不泄露存在性）
- 游标分页三页无重复、跨页日期连续、hasMore 正确
- 日聚合增量正确（含体重取最后一次、媒体计数）
- 统计字段与前端契约一致、X 轴连续补 0
- 打卡 streak / 月历 / 徽章解锁
- AI 总结：LLM 路径、缓存命中、force 走重试额度、额度用尽 429、数据不足引导
- 降级四条路径：超时、非 JSON、医疗表述拦截、恐吓表述改写
- 删除后聚合回减、软删进回收站、媒体标记孤儿
- 对账修正人为制造的聚合漂移、存储体检、回收站物理清理
- 入口容错：未知 action / 无身份 / 缺 action

内存版刻意模拟了云开发的三个「坑」：`add` 主键冲突抛错、`update` 不存在抛错、`doc().get()` 不存在抛错。模拟得太宽容的话，线上那些降级分支永远测不到。

---

## 六、部署

1. 开发者工具 → 云开发 → 开通环境，记下环境 ID
2. 右键 `cloudfunctions/api` → 上传并部署：云端安装依赖
3. 右键 `cloudfunctions/timerDaily` → 上传并部署
4. 控制台给 `api` 配环境变量（至少 `APP_ENV` 与 `INTERNAL_TOKEN`）
5. 建 9 个集合，权限选**「仅创建者可读写」**
6. 按 `scripts/indexes.json` 建索引
7. 跑自检：

```json
{ "action": "admin.dbCheck", "token": "..." }
{ "action": "admin.llmInspect", "payload": { "probe": true }, "token": "..." }
```

8. `timerDaily` 的定时触发器随 `config.json` 部署（`0 10 0 * * * *` 每天 00:10；`0 */30 * * * * *` 每 30 分钟发提醒）
9. 小程序端 `miniprogram/utils/config.js` 改 `USE_MOCK: false`

---

## 七、运维手册

| 现象 | 排查顺序 |
|---|---|
| 记录保存成功但统计不动 | `admin.dbCheck` 看脏数据 → `admin.reconcileUser` 修 → 查日志 `日聚合更新失败` |
| 列表图片全白 | 检查存的是不是临时 URL（2 小时过期）。正确做法是存 fileID，前端 image 组件直接渲染 `cloud://` |
| AI 总结一直是规则模板 | `admin.llmInspect` 看 `provider` 是否为 null → `probe:true` 看真实报错 → 检查 key / baseUrl / 出口网络 |
| 总结内容被拦截 | 查 `audit_logs` 的 `ai.blocked`，看 hit tag 是 disease 还是 medication，据此加 Prompt 约束 |
| 配额异常 | 查 `ai_quota` 里 `{userId}_{date}_{periodType}` 的 `count/retryCount`；`QUOTA_RETRY` 按天重置 |
| 定时任务只处理了一部分用户 | 看 report 的 `partial=true`，是撞了 `TIMER_BUDGET_MS` 预算。可多次触发（幂等），或拆分片 |
| 慢请求告警（>800ms） | 大概率是查询没命中索引。去控制台看慢查询，对照 `scripts/indexes.json` |

### 已知限制

1. **`timerDaily` 单次处理上限**：默认 500 用户（`TIMER_MAX_USERS`），超时预算 18s。用户量上来后要拆分片任务或改成队列。
2. **体重曲线依赖 daily_aggs 的 `weight` 字段**：只保留当日最后一次称重，同一天多次测量不会画出多个点。
3. **`media_assets` 的内容安全检测未接入**：目前 `status` 直接写 `passed`。接微信 `security.mediaCheckAsync` 后可改为异步回填 `rejected`。
4. **注销冷静期任务未实现**：`users.markDeleting` 已就位，但定时清理任务还没写（需要产品确认冷静期天数）。
