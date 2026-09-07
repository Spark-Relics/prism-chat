# Prism 架构

> Prism（棱镜）消息中枢：一束光进来，散成全平台 —— 业务代码只面对一套统一消息模型。

```
┌──────────────────────────────────────────────────────────┐
│  业务应用（任意项目）                                       │
│  · 嵌入式：@prism/sdk 直接进程内接入                        │
│  · 独立网关：@prism/server 提供 HTTP API / webhook 入口     │
└──────────────┬─────────────────────────┬─────────────────┘
               │ PrismMessage / send()   │ POST /api/send, /hooks/:channel
┌──────────────▼─────────────────────────▼─────────────────┐
│  @prism/core — PrismHub                                   │
│  · 统一消息模型 PrismMessage（结构化 content blocks）        │
│  · Inbox：幂等去重（webhook 重投不重复触发业务）             │
│  · Outbox：队列 + 指数退避重试 + 死信（DLQ）                 │
│  · 可插拔 Logger / Queue / Deduplicator                    │
└──────────────┬───────────────────────────────────────────┘
               │ ChannelAdapter 统一契约
┌──────────────▼───────────────────────────────────────────┐
│  @prism/adapter-*（独立包，互不依赖，可自由组合）             │
│  telegram · email · whatsapp · line · …（注册新插件即可）    │
└──────────────────────────────────────────────────────────┘
```

## 分层职责

| 层 | 包 | 职责 | 禁止事项 |
| --- | --- | --- | --- |
| 接入层 | `@prism/sdk` / `@prism/server` | 工厂、插件注册表、HTTP 网关 | 不含平台协议知识 |
| 中枢层 | `@prism/core` | 消息规范化、去重、重试、分发 | 不直接调用任何平台 API |
| 适配层 | `@prism/adapter-*` | 平台协议 ↔ PrismMessage 双向翻译 | 不做业务、不落库 |

## 统一消息模型

```ts
interface PrismMessage {
  id: string;              // 出站自动生成；入站由平台事件确定性派生（幂等基础）
  channel: string;         // "telegram" | "whatsapp" | "line" | "email" | ...
  direction: "inbound" | "outbound";
  from: string;            // 平台语义地址：chat id / 手机号 / userId / 邮箱
  to: string;
  content: ContentBlock[]; // text/image/audio/video/file/location/sticker/contact/template
  timestamp: number;       // epoch ms
  raw?: unknown;           // 平台原始 payload（逃生舱）
  metadata: Record<string, unknown>;
}
```

## 可靠投递

- **Inbox 幂等**：每个入站消息以 `channel:id` 声明去重键。平台 webhook 重投（Telegram 重试、WhatsApp 重发）不会重复触发业务 handler。默认内存实现，多实例部署请替换 `InboxDeduplicator`（Redis SETNX + TTL）。
- **Outbox 重试**：`send()` 入队后由管道消费，失败按指数退避（默认 2s 起、5 次上限）重试；`PrismError.retryable=false` 的错误直接进死信。死信通过 `onDeadLetter` 回调与 `dead_letter` 事件暴露。
- **多实例**：将 `OutboxQueue` / `InboxDeduplicator` 替换为 Redis/BullMQ 实现，core 零改动。

## 接入形态

1. **嵌入式 SDK**（推荐，进程内、零网络开销）：
   ```ts
   const prism = createPrism({ channels: { telegram: { botToken } } });
   await prism.start();
   ```
2. **独立网关**：`@prism/server` 统一接收各平台 webhook、转发规范化消息到业务服务，业务通过 `POST /api/send` 发消息。

## 新平台扩展

新平台 = 新增一个实现 `ChannelAdapter` 契约的包，业务侧 `registerPlugin("x", factory)` 或直接传 adapter 实例。core 与既有适配器零改动。详见 [adapter-guide.md](./adapter-guide.md)。
