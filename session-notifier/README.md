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
   - `requireInteraction` 让横幅停留。
    - **点击通知**会切到它所属的会话：调用 `uiWorkspace.openSession(sessionId)` —— 和你在侧栏点一行是同一个入口，所以落到的是你会手动打开的那个视图。`uiWorkspace` 属于别的插件，因此在点击那一刻用 `ctx.get('uiWorkspace')` 查找而不是加 inject 依赖——查不到就只关通知，不报错。
    - **把窗口提到前台**分两步：页面里 `focus()` 一次 + 80ms 后再补一次（Chromium 把通知点击算作用户激活）；**Windows 上还会请宿主半边做一次「置顶 + 立刻取消置顶」**。
      - 为什么需要宿主：页面抬不动自己所在的系统窗口——Windows 拒绝后台渲染进程的前台抢占，而桌面外壳没有向页面暴露窗口激活 IPC。宿主跑在外壳的子进程里，`process.ppid` 就是持有窗口的那个进程，所以它能精确地对这一实例的窗口做 Win32 调用，不会误抬同一台机器上的其他 DSH。
      - 具体序列：`SetWindowPos(HWND_TOPMOST)` → 合成一次裸 Alt 按键（把前台权限交出来）→ `BringWindowToTop` + `SetForegroundWindow` → 失败再走 `AttachThreadInput` 兜底 → `SetWindowPos(HWND_NOTOPMOST, SWP_NOACTIVATE)` 释放置顶。最后用 `GetForegroundWindow()` 自证，`exit 0` 才算真的到了前台。
      - 代价与边界：这次抬窗要起一个 PowerShell（约 0.5s），所以是 fire-and-forget，不阻塞点击；跨进程/跨虚拟桌面、锁屏时仍然可能失败，失败就只是没抬起窗口，不影响换会话。
      - 其他平台不注册这条路由，只走页面自己的 `focus()`，行为与之前一致。
   - **你回到该会话继续输入时，那条通知会自动消失**：`running` 从 false 变回 true 就说明你已经接管了（无论是你发了新 prompt，还是循环自己续跑），那条 toast 不该再宣称「等你处理」。只关该会话自己的那条，其它会话的提醒照常留着。
   - **在另一台设备/窗口上处理过该会话时，这条通知也会自动消失**（见下一节）。
   - 权限在第一次用户手势时**只申请一次**；拒绝后仅保留提示音，设置页会说明原因。

## 跨设备关闭过期通知

桌面通知只存在于**创建它的那个页面**。同一个 DSH 实例被多台设备（或多窗口）打开时，你在 A 设备上回答了提问、批准了审批、打开了会话或直接接管继续输入，B 设备上那条通知仍会继续宣称「这个会话在等你」。插件通过 Host 半边把「该会话已处理」广播给同一实例上的其它页面：

- **Host 半边**（`index.js`，所有平台）：
  - `POST /plugin/session-notifier/handled`：发布 `{ "sessionId": "..." }`。同一会话 2 秒内的重复上报只算一条（一次回答会被多个页面同时观察到）。
  - `GET /plugin/session-notifier/handled-events`：长轮询获取「其它页面处理过的会话」，带 `Last-Event-ID` 时回放最近 60 秒的记录；`Accept: text/event-stream` 走 SSE。
  - 记录只在进程内保留（TTL 60 秒、最多 200 条），不落盘，也不跨 DSH 实例。
  - 两条路由都先过 composition 的 `connection.requestRejection`（与抬窗路由同一道信任围栏）。浏览器半边用 `fetch` 而非 `EventSource`：桌面外壳的 `dsh-app://` 页面里 `EventSource` 拿不到信任围栏需要的凭据。
- **浏览器半边**：本页观察到以下任一「已处理」信号时，关闭本页该会话的通知，并上报一次（同会话 1.5 秒内去重）：
  - `running` 由 false 变 true（接管/续跑）；
  - `pendingInteraction` 消失（在本页回答了提问/审批）；
  - `completionUnread` 由 true 变 false（在本页读掉了完成）；
  - 点击了该会话的通知。
- 收到其它页面广播的 `handled` 时只关闭对应通知，**不会再次上报**，避免回环。
- 局限：只覆盖连到**同一个 DSH 进程**的页面；页面必须开着（通知本来就由页面创建）；广播有几十毫秒级的轮询延迟；未登录/跨站调用会被信任围栏拒绝。

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
  - 「测试抬窗」直接走一遍宿主抬窗链路（不经过通知），用来单独验证客户端 → 宿主的通路；
  - 「允许桌面通知」手动申请权限；
  - 状态行显示通知权限、音频、圆角图标、已提醒次数、最近一次提醒的结果与发送时窗口状态；
  - 状态行末尾的 `抬窗` 是最近一次抬窗的结果：`raised` 表示宿主接受了请求，`not-windows` / `no-fetch` / `http-4xx` / `failed` 各自指向不同故障面；
  - 「恢复默认」清空所有自定义。

设置保存在 `localStorage` 的 `dsh.session-notifier.v2`，刷新后保留。首次加载会自动迁移两个旧插件的键：

| 旧键 | 来源 | 迁移方式 |
| --- | --- | --- |
| `dsh.session-notifier.v1` | desktop / `session-notifier` | 提示音、桌面通知、查看时静音 |
| `dsh-reminder:settings` | server / `dsh-reminder` | 总开关、提示音、桌面通知、标题模板、子代理策略（`subagents` 同时映射到完成/交互两个开关）、`onlyWhenAway` 映射为查看时静音 |

## 控制台 / 服务面

```js
__dshSessionNotifier.probe()        // 音频/权限/图标/计数/最近一次/诊断/跨设备计数
__dshSessionNotifier.describe()     // 当前全部设置与最近一次提醒
__dshSessionNotifier.test()         // 立刻试一次「需要你介入」
__dshSessionNotifier.test('done')   // 立刻试一次「已完成」
__dshSessionNotifier.getSettings()
__dshSessionNotifier.setSettings({ skipFocused: false, titles: { done: '收工：{session}' } })
__dshSessionNotifier.resetSettings()
__dshSessionNotifier.setTitleTemplate('question', '【{session}】来消息了')
```

旧钩子名 `__dshReminder` 保留为同一对象的别名；服务面为 `ctx.sessionNotifier`。`probe().crossDevice` 给出本页发布/接收过的 `handled` 记录数（`published` / `received`）与最近一次的会话 id，用来判断跨设备关闭是否在正常工作。

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

> **改了 `index.js`（宿主半边）需要重启 DSH。** 宿主模块在进程启动时求值一次，DSH 的 HMR 只监听 profile 配置、不监听插件源码；刷新页面只换浏览器半边。

## 验证

```bash
node session-notifier/tools/test-session-notifier.mjs        # 浏览器半边，81 项
node session-notifier/tools/test-session-notifier-host.mjs   # 宿主半边，31 项
npm run check                                               # 语法检查
```

测试用受控时钟加载真实 `client.js`，覆盖：完成候选的 settle/goal quiet/轮次推进丢弃、交互立即提醒与按 key 去重、子会话两种标记（`origin`/`parentId`）的完成与交互策略、聚焦/主视图跳过（投递时求值）、重连基线门禁、首次快照静默、提示音冷却与批量上限、Windows 安全 tag/关闭旧通知/圆角图标/`requireInteraction`、点击通知打开对应会话（含 `uiWorkspace` 缺席与无会话的手动测试）、用户接管后撤下旧通知（只撤该会话那条）、**本页处理与远端处理的广播/去重/不回声**、权限与不支持环境的降级、设置持久化与两个旧键的迁移、标题模板、设置页结构、控制台 API、dispose。

它**不能**证明真实浏览器里出声、Windows toast 的最终观感与桌面应用内的行为——这些需要真实 GUI 验证。

### 阈值复算

`tools/probe-round-cadence.mjs` 读取 `~/.dsh/sessions` 的持久化日志（每行一个 zstd 帧，`tools/lib/session-log.mjs` 负责分帧解压），按「谁唤醒了下一轮」分类统计 `turn/end` → 下一次 `turn/start` 的间隔，用来复核 1.2s / 15s 两个窗口：

```bash
node session-notifier/tools/probe-round-cadence.mjs
```

本机实测（2026-11）：goal 续跑 p99 ≈ 375ms（1.2s 窗口可吸收 100%），human 间隔 p50 约 6 分钟，subagent 结算多在 60s 以上。窗口数值与观测一致。

插件自身零运行时依赖，测试与复算脚本同样不需要额外依赖。