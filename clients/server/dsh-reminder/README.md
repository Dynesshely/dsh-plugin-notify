# dsh-reminder

DSH Web 插件：当**需要你介入**或**会话在你不看它的时候干完了**，用**提示音**和
**系统通知**提醒你。

## 触发条件

| 事件 | 何时触发 | 提醒文案（中文） |
| --- | --- | --- |
| 等待你回答问题（`ask_user_question` / plan review） | 某个会话出现新的待回答请求 | ❓ 需要你回答 · <会话名>（正文是问题原文） |
| 等待你批准工具调用 | 某个会话出现新的审批请求 | 🔐 需要你批准 · <会话名>（正文是原因/tool 名） |
| 会话完成了这一轮 | 该会话从"运行中"变为停止（**默认任何时候都提醒**，哪怕你正看着它）；`setOnlyWhenAway(true)` 可限制为"它不在主视图时" | ✅ 会话已完成 · <会话名> |

判定用的是 DSH 客户端**已有的事实**，不是我猜的启发式：`ui-session` 的
`SessionStatus`（`running` / `pendingInteraction` / `completionUnread`），也就是侧边栏
那个"未读完成"圆点背后的同一份状态。

> 为什么"看着它"也会提醒：v1 只用了 `completionUnread`，而它按定义**排除**了当前
> 主视图——于是你一边盯着会话一边等结果时不会有任何反应（除非切走）。现在完成提醒
> 直接看 `running` 的下降沿，默认不看你是否在看；想回到"只在别处时才响"就
> `setOnlyWhenAway(true)`。

## 提醒方式

1. **提示音**：Web Audio 合成，无需音频文件。
   - 需要你介入：三声上行三角波（987 → 1318 → 987 Hz）
   - 已完成：两声下行正弦（659 → 494 Hz，更"轻"）
2. **系统通知**：`Notification` API；点击通知会聚焦窗口并打开对应会话。
   **通知图标复用页面自己的图标**（DSH favicon）。注意：DSH 的 favicon 是
   `/favicon.svg`，而 Web 通知**不渲染 SVG**，所以插件在激活时把该 SVG 取回并用
   canvas 光栅化成 128×128 PNG（一次性，结果缓存在内存里）再交给通知；若页面声明的
   本来就是位图就原样使用；光栅化失败则退回原始 href。`__dshReminder.probe().icon`
   会报告 `pending | ready | unavailable | none`。

权限与自动播放策略：

- 浏览器要求**页面内至少有一次用户交互**才允许出声。首次 pointerdown / keydown
  会解锁音频上下文；同样在这第一次交互时，如果通知权限还是 `default`，插件会
  **只请求一次**通知权限。拒绝后不再询问，提示音照常。
- 在极少数"页面刚加载、你还没碰过页面"的情况下，提醒会到达但没有声音（浏览器
  策略，不是插件缺陷）。

## 设置页

同一个页面注册在**两个入口**，随便从哪个进都行：

1. **设置 → 提醒**：自己的导航行（`settings.section`，位于"已归档会话"和
   Better Sidebar 之间）——最容易找到；
2. **设置 → 插件 → “提醒”页签**：插件设置区里的页签（`settings.plugins.tab`）。

页面内容：

- **测试：需要你介入** —— 立刻发一条"需要你"提醒（三声提示音 + 通知）
- **测试：会话已完成** —— 立刻发一条"已完成"提醒（两声提示音 + 通知）
- 状态行：`通知权限 · 音频 · 图标 · 已提醒 N · 最近一次`

这是验证"到底响不响、图标对不对"最快的入口，不用开控制台。按钮用的是宿主自己的
组件与主题 token（`Button` + `--dsw-alias-label-*`），文案走 locale 词典（zh/en），
所以它会跟着界面语言走、也跟着主题明暗走。

## 默认值与可调项

默认：总开关开、提示音开、系统通知开、**子代理会话不提醒**（一次 fan-out 可能同时
结束几十个子代理，会吵）。浏览器控制台里可随时改：

```js
__dshReminder.probe()                 // ← 没响的时候先跑这个：音频状态/权限/计数/最近一次
__dshReminder.describe()              // 看当前开关与最近一次提醒
__dshReminder.test('done')            // 立刻试一次"已完成"提醒
__dshReminder.test()                  // 立刻试一次"需要你"提醒
__dshReminder.setSound(false)         // 关提示音
__dshReminder.setDesktop(false)       // 关系统通知
__dshReminder.setEnabled(false)       // 整个关掉
__dshReminder.setSubagents(true)      // 子代理完成也提醒
__dshReminder.setOnlyWhenAway(true)   // 完成提醒只在"不在主视图"时响
__dshReminder.notificationPermission()   // 'granted' | 'denied' | 'default' | 'unsupported'
__dshReminder.requestPermission()        // 手动再请求一次权限
```

`probe()` 里 `audio` 字段的含义：`not-created-yet`＝页面还没发生过交互（浏览器不允许
出声），`suspended`＝建过但被浏览器挂起，`running`＝可以出声。

这些开关只作用于当前页面（刷新即回默认值）；插件同时通过 `ctx.reminder` 服务面
对外暴露同一组方法，后续可以把它们接到设置页里。

## 不会重复吵你

- **首次快照静默**：插件刚激活/页面刚刷新时**第一次**读到的状态被直接采纳，不补报。
  （刷新后若已经有一个问题在等你回答，它多半出现在后续快照里，会补响一次——每个请求
  只响一次，这是刻意的：漏掉问题比多响一声更糟。）
- **按请求去重**：同一个待回答请求（`key` 不变）只会提醒一次；同样，同一个会话的
  运行状态抖动不会重复提醒；换成**新的**请求（新 `key`）才会再次提醒。
- **一次停止只响一次**：`running` 下降沿与 `completionUnread` 同时到达时只提醒一次。
- **重连基线不响**：会话列表还没到 `ready` 阶段前的完成事件不提醒（避免重连回放炸一串）。
- **回答后再次完成**会重新提醒：这是新的一轮结束。
- 详见 `test/reminder.test.mjs`：这些规则每一条都有断言。

## 安装 / 卸载 / 刷新

```
plugin_manager install_bundle  ->  <本目录绝对路径>
plugin_manager remove_bundle   ->  dsh-reminder
```

新安装的 bundle 需要**刷新一次页面**才会加载：长驻页面不保证会应用实时 graph 帧。

## 验证

`test/reminder.test.mjs` 用 stub 的 Web Audio / Notification / favicon 光栅化 / React 渲染
与手工驱动的 `uiSession.sessionStatus` 快照跑真实的 `client/client.js`，覆盖 43 项断言：
首次快照静默、按 key 去重、`running` 下降沿即提醒（含"正看着它"）、首次见到就已 unread
的行保持静默、双信号同时到达只响一次、`onlyWhenAway` 两种行为、基线阶段不响、子代理
过滤（默认关/开启后提醒）、权限被拒时只响提示音、音频上下文被挂起时降级为 `resume()`
而不抛错、首次手势只请求一次权限、通知携带光栅化后的图标、光栅化失败时退回原始 favicon
href、设置页注册（页签名/本地化标签/两个测试按钮真的会触发提醒/状态行）、控制台测试
钩子与 `probe()`、dispose 后彻底停止。

它**不能**证明真实浏览器里真的出声/真的弹出系统通知——那部分只能由真实 GUI 验证。

```bash
npm install
npm test
```

测试用 `jsdom` 模拟浏览器（唯一的 devDependency；插件自身零运行时依赖）。
