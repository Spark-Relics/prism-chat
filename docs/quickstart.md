# 快速开始

## 1. 嵌入式 SDK（任意 Node.js / TS 项目）

```bash
pnpm add @prism/sdk
```

```ts
import { createPrism, text } from "@prism/sdk";

const prism = createPrism({
  channels: {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN!, // @BotFather 获取
      mode: "polling", // 开发期长轮询，无需公网
    },
    email: {
      fromAddress: "bot@example.com",
      smtp: { host: "smtp.example.com", port: 465, secure: true, auth: { user: "...", pass: "..." } },
    },
  },
});

// 统一处理全平台入站消息
prism.onMessage(async (msg) => {
  console.log(`[${msg.channel}] ${msg.from}: ${msg.content[0]?.type}`);
  if (msg.channel === "telegram") {
    await prism.send({
      channel: "telegram",
      to: msg.from,
      content: [text("已收到你的消息")],
    });
  }
});

await prism.start();
```

Telegram polling 模式下，给机器人发消息即可看到全链路。Email 入站需配 SendGrid Inbound Parse / Postmark inbound webhook 指向网关（见下）。

## 2. 独立网关（@prism/server）

```bash
git clone https://github.com/Spark-Relics/prism-chat.git
cd prism-chat
pnpm install && pnpm build
node packages/server/dist/cli.js --config config.example.json
```

| 端点 | 说明 |
| --- | --- |
| `POST /hooks/:channel` | 各平台 webhook 统一入口（验签 → 规范化 → 去重 → 转发） |
| `GET /hooks/whatsapp` | Meta 订阅握手 |
| `POST /api/send` | 统一发送：`{ channel, to, content: [{type:"text",text:"hi"}] }` |
| `GET /api/channels` | 已注册渠道与能力声明 |
| `GET /healthz` | 健康检查 |

`forwardUrl` 指向你的业务服务，网关会把规范化后的 `PrismMessage` POST 过去（带 `Authorization: Bearer <apiToken>`）。

## 3. 下一步

- 架构与设计原则：[architecture.md](./architecture.md)
- 编写新平台适配器：[adapter-guide.md](./adapter-guide.md)
