本项目完全通过Vibe Coding实现
# codex-im

`codex-im` 是一个本地运行的飞书机器人桥接层：

`飞书消息 -> 本机 codex app-server -> 飞书回复`

Codex、git、workspace 操作都留在 本地，飞书只负责消息交互。

## 特性

- 飞书长连接机器人
- 普通对话回复
- 卡片回复与流式更新
- 先加表情、后输出正文
- 回复到触发它的原消息
- `/codex bind` 绑定工作目录
- `/codex where` 查看当前目录/线程
- `/codex workspaces` 查看当前会话已记录目录和线程
- `/codex use <threadId>` 切换线程
- `/codex message` 查看最近几轮消息
- `/codex new` 新建线程
- `/codex stop` 停止当前运行
- 审批卡片与 `/codex approve` / `/codex reject`

## 安装

全局安装：

```sh
npm install -g codex-im
```

开发态运行：

```sh
npm install
npm run feishu-bot
```

## 配置

全局安装后，建议把配置文件放在：

```text
~/.codex-im/.env
```

开发态也可以直接放在当前目录 `.env`。

程序会按这个顺序加载配置：

1. 当前目录下的 `.env`
2. `~/.codex-im/.env`
3. 当前 shell 环境变量

示例：

```sh
mkdir -p ~/.codex-im
cp .env.example ~/.codex-im/.env
```

必填环境变量：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

可选环境变量：

- `CODEX_IM_FEISHU_BOT_NAME`
- `CODEX_IM_DEFAULT_WORKSPACE_ID`
- `CODEX_IM_WORKSPACE_ALLOWLIST`
- `CODEX_IM_CODEX_ENDPOINT`
- `CODEX_IM_SESSIONS_FILE`

默认 session 文件位置：

```text
~/.codex-im/sessions.json
```

## 使用

启动：

```sh
codex-im
```

如果是源码目录运行，也可以：

```sh
npm run feishu-bot
```

常用命令：

- `/codex bind /绝对路径`
- `/codex where`
- `/codex workspaces`
- `/codex use <threadId>`
- `/codex message`
- `/codex new`
- `/codex stop`
- `/codex approve`
- `/codex approve session`
- `/codex reject`
- `/codex help`

## 目录与线程模型

- 一个飞书会话可以记住多个工作目录
- 每个工作目录对应一个当前选中的 Codex 线程
- 历史线程列表以 Codex `thread/list` 为准
- 切换目录或线程后，后续普通消息继续发到当前线程

## 工作方式

- 收到用户消息后，先用表情标记正在处理
- Codex 返回内容后，飞书中以卡片形式持续更新
- 命令回执和普通对话都会优先回复到触发它的原消息
- 审批请求会显示为交互卡片

## 开发

- `src/index.js`: 启动入口
- `src/feishu-bot.js`: 飞书机器人主逻辑
- `src/codex-rpc-client.js`: Codex JSON-RPC 传输层
- `src/session-store.js`: 会话绑定持久化
- `src/config.js`: 环境变量配置

## 发布

发布到 npm 前，你还需要自己确认：

- `package.json` 的 `license`
- `package.json` 的 `repository`

发布命令：

```sh
npm login
npm publish
```

# 飞书配置
card.action.trigger


# 参考项目
https://github.com/larksuite/openclaw-lark
https://github.com/Emanuele-web04/remodex
https://github.com/Dimillian/CodexMonitor