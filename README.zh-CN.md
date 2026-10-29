<div align="center">

# Juno

### 住在你们群聊里的 AI 同事。

把 Juno 拉进 Slack、飞书、Discord 或 Telegram 的群里：群里每个人都能找它办事。
它用自己的云电脑和你连接的应用把事做完，会主动跟进，越用越懂你们团队怎么做事。
可以自己部署，模型用你自己的。

[English](README.md) · [部署](#部署到自己的服务器) · [架构](docs/ARCHITECTURE.md) · [参与开发](CONTRIBUTING.md)

</div>

[![观看 Juno 短片（110 秒）](.github/assets/juno-story-poster.jpg)](https://github.com/nigelleong0703/juno/releases/download/v0.2.0/juno-story.mp4)

*工作和生活里的 Juno：工作上赶一个产品发布，生活里和朋友约行程。画面来自真实 App 录屏，使用演示账号。*

## 为什么是 Juno

大多数 AI 助手只为一个人服务，而且只待在自己的 App 里。可真正的工作发生在群里：好几个人在提要求、拍板、改主意。

Juno 就是为这种场景做的：

- **进到你们已经在用的群里。** 每个 agent 在 Slack、飞书、Discord、Telegram 上都有自己的 bot 身份，不用复制粘贴任何 token。你在各个平台上跟它的私聊，汇成同一个对话。
- **服务整个群，不只是你。** 它知道是谁在提要求、谁说了算、每个人能知道什么。你在私聊里告诉它的私事，不会出现在群里。
- **真的动手做事。** 每个 agent 有一台云电脑，里面有浏览器、终端和文件；你允许的话，它也能用你的 Mac。它还能用你连接的应用：Google、Microsoft 365、Notion、Linear、Stripe，你自己加的任何 MCP 服务器，以及经过审核、通过 Composio 接入的长尾应用。
- **动手前先问你。** 发邮件、付款、删除这类操作都会弹出审批卡片，写清楚会产生什么后果。哪些事每个 agent 可以不问就做，由你决定。
- **会记住，也会进步。** 人、偏好、群规矩、你纠正过的地方都会变成记忆，你可以随时查看和修改。技能根据真实结果改进，分批上线，随时可以回滚。
- **你不在，它也在干活。** 定时任务、跟进和长任务跑在持久化的 worker 上，重启不丢，也能扩展到多个进程。

结果会以几种形式交给你：消息、可以审阅的文档、Feed 里的研究长文，以及可以分享的小网页应用。

## 客户端

| 客户端 | 状态 |
|---|---|
| 网页 | 随你的服务器一起部署 |
| iPhone | 原生 SwiftUI 源码在 [`frontend/packages/ios`](frontend/packages/ios)，用你自己的 Apple 开发者账号构建和签名 |
| Mac | Electron 源码在 [`frontend/packages/desktop`](frontend/packages/desktop)，安装包在 [Releases](https://github.com/nigelleong0703/juno-releases/releases) |
| Apple Watch | 配套应用源码在 [`frontend/packages/watch`](frontend/packages/watch) |

所有客户端都调用同一套公开 API，接口定义只有一份，在 [`backend/packages/public-contracts`](backend/packages/public-contracts)。

## 部署到自己的服务器

需要 Docker（带 Compose），以及本仓库指定的 Node 版本。

```sh
git clone https://github.com/nigelleong0703/juno.git
cd juno
node deploy/setup.mjs --check     # 生成 deploy/.env，默认值只适合本机
# 在 deploy/.env 里填公网域名、端口和 TLS，详见 deploy/README.md
node deploy/setup.mjs --up --allow-unconfigured-model   # 构建、迁移数据库、启动、等待健康检查
```

启动后登录，在设置里添加模型：任何 OpenAI 兼容的接口都可以，也可以直接登录你的 ChatGPT 账号。每个聊天平台、每个需要单独登录的应用，都要先去对应平台注册应用，[deploy/README.md](deploy/README.md) 里列出了要注册哪些。

想让 AI 助手帮你装？把 [prompt.txt](prompt.txt) 交给它。

## 仓库结构

```text
backend/    API、agent 运行时、持久化 worker、记忆、聊天渠道、应用连接、电脑服务
frontend/   网页、Mac、iPhone、Watch 客户端，以及共用的客户端和界面包
deploy/     服务器部署和容器
docs/       架构和开发说明
```

开发环境：Node 26、pnpm 12.9.1。先 `pnpm install`，再 `pnpm check`。详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 现状

Juno 还在早期，正在快速开发，接口经常变动。遇到问题欢迎开 issue。

MIT 许可证。第三方代码和素材保留各自的许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
