# dsh-plugin-notify

DeepSeek Harness（DSH）的通知插件仓库。

| 插件 | 说明 |
| --- | --- |
| [`session-notifier`](./session-notifier) | 唯一维护的通知插件：任意会话需要你交互，或真正停下来等你时，播放提示音并发送桌面通知；循环轮次与子代理完成默认静默 |

## 为什么只剩一个插件

仓库此前按「桌面端 / 服务端」分两条 line 维护两个实现：

- `clients/desktop/session-notifier`：空闲判定与 Windows toast 处理更成熟；
- `clients/server/dsh-reminder`：设置页、标题模板、圆角图标与子会话策略更完善。

扫描后确认两端**没有平台级差异**：Host 半边都是空实现，注入同一批 Client 服务（`uiSession.sessionStatus`、`sessions.list`、`locale`、`slots`），使用同一套 Web Audio + Notification 投递；桌面端唯一的 Electron 特征只是诊断文案。双线维护只会带来行为漂移和同一 bug 修两次。

因此两者已合并为根目录下的 `session-notifier/`：

- 决策与投递采用原桌面端的引擎（完成候选的 1.2s/15s 静默窗口、goal 轮次、Windows 安全 tag、关闭旧通知、批量上限、提示音冷却、诊断）；
- 设置页与可调项采用原服务端的形态（总开关、标题模板、圆角图标、子会话两个开关、测试按钮、控制台 API）；
- 设置迁移：`dsh.session-notifier.v1`（旧桌面端）与 `dsh-reminder:settings`（旧服务端）都会在首次加载时并入 `dsh.session-notifier.v2`。

`clients/desktop` 与 `clients/server` 两条长期分支保留为历史归档，不再更新；新代码只进 `main`。

## 目录

```
session-notifier/
├── package.json            # bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml        # 向 profile 插入插件行
├── index.js                # Host 半边，空实现
├── client.js               # 浏览器半边：判定、提示音、桌面通知、设置页、控制台 API
├── locale/{zh,en}.json     # 插件管理页的标题与描述
├── tools/                  # 受控时钟的行为测试
└── README.md               # 触发条件、设置、迁移、验证
```

## 安装 / 卸载

```
plugin_manager install_bundle  ->  <session-notifier 目录绝对路径>
plugin_manager remove_bundle   ->  dsh-session-notifier
```

以 `link:` 方式安装时，源码改动刷新页面即生效；新安装的 bundle 需要刷新一次页面才会加载。

## 验证

```bash
node session-notifier/tools/test-session-notifier.mjs
cd session-notifier && npm run check
```

插件自身零运行时依赖，测试同样不需要额外依赖。
