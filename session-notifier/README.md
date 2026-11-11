# session-notifier

DSH Web 插件：当**某个会话需要你介入**，或**它真的停下来等你**时，用提示音和系统通知提醒你。

这是仓库里唯一维护的通知插件，由原先的 `clients/desktop/session-notifier` 与 `clients/server/dsh-reminder` 合并而来（见根 README 的迁移说明）。

## 触发条件

| 事件 | 何时触发 | 默认标题 |
| --- | --- | --- |
| 等待你回答 / 计划评审 / 审批 | 某个会话出现新的待交互请求时立刻提醒 | 需要你回答 / 需要你确认计划 / 需要你批准 · <会话名> |
| 会话真正停下来 | 一轮结束**不是**「轮到你」：目标驱动、排队续跑、子代理结算都会自动开下一轮。插件把完成候选按住观察，确认会话不再自己往下走才提醒 | 会话已完成 · <会话名> |
| 子代理完成 | 默认不提醒（主会话还在运行，会自己汇报） | — |
| 子代理需要交互 | 默认提醒（它卡在审批/提问时只有你能推动），标题带「子代理」前缀 | 需要你批准 · 子代理 <名字> |

判定依据全部来自 DSH 客户端已有的事实：

- `uiSession.sessionStatus`：`pendingInteraction`、`running`、`completionUnread`；
- `sessions.list`：会话标题 / `origin` / `parentId` / `projectionValues.goal`；
- `uiSession.adapter.current`（或 `retainedBy.mainView`）：当前主视图里的会话。

### 「真正停下来」的判定

- 轮次结束后先按住 **1.2 秒**：
  - 会话又跑起来（循环续跑、排队消息、子代理结算唤醒）→ 丢弃，不提醒；
  - 目标（goal）还在 `active` 且轮次前进了 → 丢弃；
  - 目标 `active` 但轮次迟迟不前进 → 等 **15 秒** quiet 窗口后再提醒（给落盘检查点留余量，也避免卡住的目标永久静默）；
  - 目标 `complete` / `paused` / `blocked`，或没有目标 → 1.2 秒后确认没有动静就提醒。

窗口数值来自真实会话日志的实测（目标续跑 p99 约 1 秒内，人工输入间隔以分钟计），不是拍脑袋。

## 提醒方式

1. **提示音**：Web Audio 实时合成，无需音频文件。
   - 需要你介入：两声上行（880 → 1174.66 Hz）
   - 已完成：两声下行（659.25 → 987.77 Hz，更轻）
   - 900ms 冷却，避免一批完成变成警报器；首次页面交互时解锁音频上下文。
2. **桌面通知**：页面 `Notification` API（Electron 窗口内即系统通知）。
   - **图标**：内嵌 DSH 应用图标（PNG），激活时用 canvas 重绘成 128×128 **圆角** PNG，不依赖页面资源路由。
   - **Windows 兼容**：每条通知使用**唯一且不超过 16 字符**的 tag（Windows 对超长 tag 会直接拒绝，渲染进程看不到失败）；同一会话的上一条通知会先 `close()`，避免「同 tag 静默替换、不弹横幅」。
   - `requireInteraction` 让横幅停留；点击通知聚焦窗口并关闭它。
   - 权限在第一次用户手势时**只申请一次**；拒绝后仅保留提示音，设置页会说明原因。

## 设置

**设置 → 会话提醒**（同一个页面也注册在 **设置 → 插件 → 会话提醒** 页签）：

- **提醒方式**：总开关、提示音、桌面通知；
- **提醒范围**：
  - 正在查看该会话时不提醒（窗口聚焦 + 该会话在主视图时，连交互提醒也跳过；默认开）
  - 子会话 / 子代理完成时也提醒（默认关）
  - 子会话 / 子代理需要交互时也提醒（默认开）
- **标题模板**：问题 / 计划评审 / 审批 / 完成四类，`{session}` 会替换成会话名；留空使用当前语言的默认文案；
- **测试与状态**：
  - 「测试：需要你介入」「测试：会话已完成」立刻走真实投递链路；
  - 「10 秒后测试」用于切到别的窗口后验证失焦投递；
  - 「允许桌面通知」手动申请权限；
  - 状态行显示通知权限、音频、圆角图标、已提醒次数、最近一次提醒的结果与发送时窗口状态；
  - 「恢复默认」清空所有自定义。

设置保存在 `localStorage` 的 `dsh.session-notifier.v2`，刷新后保留。首次加载会自动迁移两个旧插件的键：

| 旧键 | 来源 | 迁移方式 |
| --- | --- | --- |
| `dsh.session-notifier.v1` | desktop / `session-notifier` | 提示音、桌面通知、查看时静音 |
| `dsh-reminder:settings` | server / `dsh-reminder` | 总开关、提示音、桌面通知、标题模板、子代理策略（`subagents` 同时映射到完成/交互两个开关）、`onlyWhenAway` 映射为查看时静音 |

## 控制台 / 服务面

```js
__dshSessionNotifier.probe()        // 音频/权限/图标/计数/最近一次/诊断
__dshSessionNotifier.describe()     // 当前全部设置与最近一次提醒
__dshSessionNotifier.test()         // 立刻试一次「需要你介入」
__dshSessionNotifier.test('done')   // 立刻试一次「已完成」
__dshSessionNotifier.getSettings()
__dshSessionNotifier.setSettings({ skipFocused: false, titles: { done: '收工：{session}' } })
__dshSessionNotifier.resetSettings()
__dshSessionNotifier.setTitleTemplate('question', '【{session}】来消息了')
```

旧钩子名 `__dshReminder` 保留为同一对象的别名；服务面为 `ctx.sessionNotifier`。

## 兼容与降级

- 没有 `Notification` API 或权限被拒：只保留提示音，状态行说明原因；
- 页面从未发生用户交互：浏览器不允许出声，点击页面即可；
- 页面关闭时不会提醒（事件驱动）；
- 已用 `localStorage` 禁用：设置退化为仅本页有效。

## 安装 / 卸载

```
plugin_manager install_bundle  ->  <本目录绝对路径>
plugin_manager remove_bundle   ->  dsh-session-notifier
```

新安装或源码更新后**刷新一次页面**才会加载（长驻页面不保证应用实时 graph 帧）。以 `link:` 方式安装时，刷新页面即生效。

## 验证

```bash
node session-notifier/tools/test-session-notifier.mjs   # 60 项断言
npm run check                                          # 语法检查
```

测试用受控时钟加载真实 `client.js`，覆盖：完成候选的 settle/goal quiet/轮次推进丢弃、交互立即提醒与按 key 去重、子会话两种标记（`origin`/`parentId`）的完成与交互策略、聚焦/主视图跳过（投递时求值）、重连基线门禁、首次快照静默、提示音冷却与批量上限、Windows 安全 tag/关闭旧通知/圆角图标/`requireInteraction`、权限与不支持环境的降级、设置持久化与两个旧键的迁移、标题模板、设置页结构、控制台 API、dispose。

它**不能**证明真实浏览器里出声、Windows toast 的最终观感与桌面应用内的行为——这些需要真实 GUI 验证。

### 阈值复算

`tools/probe-round-cadence.mjs` 读取 `~/.dsh/sessions` 的持久化日志（每行一个 zstd 帧，`tools/lib/session-log.mjs` 负责分帧解压），按「谁唤醒了下一轮」分类统计 `turn/end` → 下一次 `turn/start` 的间隔，用来复核 1.2s / 15s 两个窗口：

```bash
node session-notifier/tools/probe-round-cadence.mjs
```

本机实测（2026-11）：goal 续跑 p99 ≈ 375ms（1.2s 窗口可吸收 100%），human 间隔 p50 约 6 分钟，subagent 结算多在 60s 以上。窗口数值与观测一致。

插件自身零运行时依赖，测试与复算脚本同样不需要额外依赖。
