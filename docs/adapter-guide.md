# 适配器开发指南

新平台接入 Prism 只需实现一个契约：`ChannelAdapter`（定义在 `@prism/core`）。适配器是纯协议翻译层 —— 只做「平台格式 ↔ PrismMessage」双向转换，不落库、不做业务。

## 契约

```ts
interface ChannelAdapter {
  readonly channel: string;              // 唯一渠道 id，如 "discord"
  readonly displayName: string;
  readonly requiredConfigKeys: readonly string[];

  capabilities(): AdapterCapabilities;   // 声明支持的收发块类型与特性
  start(ctx: AdapterContext): Promise<void>;  // 启动轮询/注册 webhook 等
  stop(): Promise<void>;                      // 幂等停止
  send(message: PrismMessage, options?): Promise<DeliveryResult>;
  verifyWebhook(req: WebhookRequest): boolean; // 验签；false = 网关回 401
  parseWebhook(req: WebhookRequest): PrismMessage[]; // 平台 payload → 统一消息
}
```

## 开发步骤

1. **建包**：`packages/adapter-<channel>`，依赖仅 `@prism/core`。
2. **出站**：在 `send()` 中把 `ContentBlock[]` 翻译为平台 API 调用。多块内容按平台能力拆成多条原生消息。失败时抛 `PrismError` 并标注 `retryable`（5xx/429 → true；参数错误/鉴权失败 → false，直接死信）。
3. **入站**：
   - webhook 型：实现 `verifyWebhook` + `parseWebhook`；
   - 轮询型：在 `start()` 里起轮询，用 `ctx.dispatchInbound(messages)` 喂给管道。
4. **幂等 id**：入站消息 id 必须由平台事件确定性派生（`deterministicId(channel, platformEventId)`），这是去重的基础。
5. **能力声明**：如实填写 `capabilities()`，业务层可据此做降级。

## Webhook 验签

`verifyWebhook` 返回 `false` 时网关直接回 401，消息不会进入管线。实现时注意：

- 用 `req.rawBody`（原始字节）而不是重新序列化的 `req.body` 计算 HMAC——JSON 重序列化的键序/空白差异会导致签名不匹配。
- 用常数时间比较（`crypto.timingSafeEqual`）防时序攻击。
- 参考实现：`@prism/adapter-whatsapp` 的 `X-Hub-Signature-256` 校验、`@prism/adapter-telegram` 的 secret token 比对。

## 注册方式

```ts
// 运行时注册（SDK）
import { registerPlugin } from "@prism/sdk";
registerPlugin("discord", (opts) => new DiscordAdapter(opts as DiscordOptions));
const prism = createPrism({ channels: { discord: { token: "..." } } });

// 或直接传实例
createPrism({ adapters: [new DiscordAdapter({ token: "..." })] });
```

## 检查清单

- [ ] 空配置 / 错误配置抛 `ConfigurationError`
- [ ] `stop()` 可安全重复调用
- [ ] 平台重发 webhook 不会产生不同的入站 id
- [ ] 不可恢复错误未被标记为 retryable
- [ ] `raw` 保留了平台原始 payload
