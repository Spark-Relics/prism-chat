# Prism · 棱镜消息中枢

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 一束光进来，散成全平台 —— 通用消息中枢 SDK，用一套统一消息模型打通 Telegram、WhatsApp、LINE、Email 等主流平台。

## 为什么是 Prism

接入的消息平台越多，业务代码就越容易被各家 SDK 的差异淹没：Telegram 的 update、WhatsApp 的 Cloud API payload、LINE 的 signature、Email 的 MIME……Prism 把这些全部收敛在一个适配层，业务只面对 `PrismMessage`：

```ts
import { createPrism, text } from "@prism/sdk";

const prism = createPrism({
  channels: {
    telegram: { botToken: process.env.TG_TOKEN!, mode: "polling" },
    email: { fromAddress: "bot@example.com", smtp: { host: "smtp.example.com" } },
  },
});

// 全平台入站消息，一个回调搞定
prism.onMessage(async (msg) => {
  await prism.send({ channel: msg.channel, to: msg.from, content: [text("收到 ✓")] });
});

await prism.start();
```

## 特性

- **协议无关**：统一消息信封 + 结构化内容块（text/image/file/location/template…），适配器负责双向翻译
- **可靠投递**：Outbox 队列 + 指数退避重试 + 死信；Inbox 幂等去重，webhook 重投不重复触发业务
- **插入式架构**：新平台 = 一个实现 `ChannelAdapter` 契约的包，`registerPlugin()` 即插即用，core 零改动
- **两种接入形态**：进程内嵌入（`@prism/sdk`）或独立网关服务（`@prism/server`，HTTP API + 统一 webhook 入口）
- **可插拔基础设施**：Logger / 队列 / 去重器全部接口化，内存实现起步，Redis/BullMQ 无缝替换
- **零框架绑定**：core 仅依赖 Node 标准库；网关用 Fastify 但可选

## 包结构

| 包 | 说明 |
| --- | --- |
| [`@prism/core`](./packages/core) | 消息模型、适配器契约、可靠投递管道 |
| [`@prism/sdk`](./packages/sdk) | 一行创建中枢 + 插件注册表（聚合全部官方适配器） |
| [`@prism/server`](./packages/server) | 独立网关：`/hooks/:channel` 统一 webhook、`/api/send` 统一发送 |
| [`@prism/adapter-telegram`](./packages/adapter-telegram) | Telegram Bot API（polling + webhook 双模式） |
| [`@prism/adapter-telegram-user`](./packages/adapter-telegram-user) | Telegram 私人号 MTProto userbot（GramJS，⚠️ 违反 ToS 风险自担） |
| [`@prism/adapter-email`](./packages/adapter-email) | SMTP 发送 + SendGrid/Postmark/Mailgun 入站解析 |
| [`@prism/adapter-whatsapp`](./packages/adapter-whatsapp) | WhatsApp Cloud API（骨架：验签握手 + 收发） |
| [`@prism/adapter-line`](./packages/adapter-line) | LINE Messaging API（骨架：HMAC 验签 + 收发） |

## 快速开始

```bash
pnpm install
pnpm build
```

详见 [快速开始](./docs/quickstart.md) · [架构](./docs/architecture.md) · [适配器开发指南](./docs/adapter-guide.md) · [API 规范 (OpenAPI)](./docs/openapi.yaml) · [非 Node 语言接入](./docs/non-node-integration.md)

## 路线图

- [x] WhatsApp：媒体块、模板消息、X-Hub-Signature-256 验签
- [ ] LINE：replyToken 快速回复、群组、富文本菜单
- [ ] Redis 队列 / 去重实现（多实例部署）
- [ ] Slack、Discord、飞书、钉钉、企业微信适配器
- [ ] 消息回执（delivery/read）统一抽象

## License

[MIT](./LICENSE) © Spark-Relics
