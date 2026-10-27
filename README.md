# dsh-plugin-notify

DeepSeek Harness（下称 DSH）的通知类插件集合。

通知插件的信号来源与运行环境强绑定，所以按运行环境分目录维护：

| 目录 | 适用环境 | 说明 |
|---|---|---|
| [`clients/desktop`](https://github.com/Dynesshely/dsh-plugin-notify/tree/clients/desktop) | **DeepSeek Harness Desktop** | 在 DSH 桌面应用（Electron 窗口）里运行的插件，client 半边跑在页面内 |
| `clients/server` | **DeepSeek Harness**（服务端） | 在自托管 / 服务端部署里运行的插件。**不在本仓库维护**，另行托管 |

两条线共享 DSH 的插件接口，但运行环境不同——一边是渲染进程里的页面，一边是服务端进程——所以互不引用、各自独立演进。

## clients/desktop

适用于 **DeepSeek Harness Desktop**。

| 插件 | 说明 |
|---|---|
| [`session-notifier`](https://github.com/Dynesshely/dsh-plugin-notify/tree/clients/desktop/session-notifier) | 会话提醒：任意会话需要你交互（提问 / 审批 / 计划审阅），或真正停下来等你时，播放提示音并发送桌面通知 |

每个子目录都是一个可安装的 DSH bundle（含 `package.json` 的 `dsh.bundle` / `dsh.client` 声明）。安装、配置与行为细节见各插件自己的 README。

## clients/server

适用于 **DeepSeek Harness**（服务端部署）。该目录的代码不在本仓库维护，请以该环境自己的仓库为准；本仓库的 README 只负责说明两者的适用范围，不描述服务端实现。

## 提交历史

`clients/desktop/` 下的源码来自独立开发过程的合并（`git subtree`），因此该目录保留了插件开发期的提交历史，与仓库 README 的提交相互独立。
