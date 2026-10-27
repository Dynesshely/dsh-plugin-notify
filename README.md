# dsh-plugin-notify

DeepSeek Harness（下称 DSH）的通知类插件集合。

通知插件的信号来源与运行环境强绑定，所以按客户端分分支、分目录维护：

| 分支 | 目录 | 适用客户端 |
| --- | --- | --- |
| `clients/desktop` | `clients/desktop/` | **DeepSeek Harness Desktop**（桌面应用） |
| `clients/server` | `clients/server/` | **DeepSeek Harness**（服务端 / 自托管部署） |

两条线共享 DSH 的插件接口，但运行环境不同，所以互不引用、各自独立演进。每个分支只维护对应客户端的目录：`clients/desktop` 分支放 `clients/desktop/`，`clients/server` 分支放 `clients/server/`。

各插件的安装与行为说明见其所在目录下的 README。
