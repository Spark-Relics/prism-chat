# 非 Node.js 语言接入指南

Prism 的核心逻辑（平台适配、验签、去重、重试、死信）全部集中在 `@prism/server` 网关。你的业务服务用什么语言写都可以，只需要说 HTTP：

```
Telegram/WhatsApp/LINE/Email ──webhook──▶ Prism 网关 ──POST forwardUrl──▶ 你的服务（任意语言）
你的服务 ──POST /api/send──▶ Prism 网关 ──平台 API──▶ 用户
```

完整 API 契约见 [openapi.yaml](./openapi.yaml)（OpenAPI 3.1，可直接生成客户端）。

## 1. 生成客户端（推荐）

```bash
# Java
openapi-generator-cli generate -i docs/openapi.yaml -g java -o ./prism-client

# Go
openapi-generator-cli generate -i docs/openapi.yaml -g go -o ./prism-client

# Python
openapi-generator-cli generate -i docs/openapi.yaml -g python -o ./prism-client
```

## 2. 或者直接裸调（任何语言都是两个请求）

**发送消息：**

```bash
curl -X POST http://gateway:3000/api/send \
  -H "Authorization: Bearer $PRISM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "telegram",
    "to": "123456789",
    "content": [{ "type": "text", "text": "Hello from anywhere" }]
  }'
```

响应 `202`，消息已进 outbox（异步投递，带重试与死信）。

**接收消息**：在你的服务上开一个 endpoint，配成网关的 `forwardUrl`。网关会把规范化后的 `PrismMessage` POST 过来（配置了 `apiToken` 时带 `Authorization: Bearer` 头，可用于验明来源）：

```json
{
  "id": "telegram:sha256...",
  "channel": "telegram",
  "direction": "inbound",
  "from": "123456789",
  "to": "bot",
  "content": [{ "type": "text", "text": "hi" }],
  "timestamp": 1700000000000,
  "metadata": { "tgMessageId": 42 }
}
```

> **重要**：入站消息的 `id` 由平台事件确定性派生，平台 webhook 重发不会产生新 id。网关侧已做去重；如果你的业务服务也可能收到重复投递（比如自身有重试），可用 `id` 再做一层幂等。

## 3. Go 示例（伪代码）

```go
// 发送
body := `{"channel":"telegram","to":"123456789","content":[{"type":"text","text":"hi"}]}`
req, _ := http.NewRequest("POST", gateway+"/api/send", strings.NewReader(body))
req.Header.Set("Authorization", "Bearer "+token)
req.Header.Set("Content-Type", "application/json")
resp, _ := http.DefaultClient.Do(req) // 202 = accepted

// 接收：任意 HTTP handler，解码 PrismMessage JSON
func forward(w http.ResponseWriter, r *http.Request) {
    var msg PrismMessage
    json.NewDecoder(r.Body).Decode(&msg)
    // 业务逻辑……
}
```

## 4. 能力查询与优雅降级

`GET /api/channels` 返回每个渠道的能力声明（可发送/接收的块类型、特性开关）。发模板消息前先查一下目标渠道是否支持 `template`，不支持就走 `text` 降级。

## 注意事项

- `/api/*` 端点在网关配置了 `apiToken` 时要求 Bearer 认证；`/hooks/*` 不需要（平台回调必须可达）。
- `forwardUrl` 收到的请求**不会重试**——网关侧 fire-and-forget。如果你的业务服务需要可靠消费，让网关把消息先落你自己的队列。
- 生产部署建议把网关放在企业 API 网关（Kong / APISIX 等）后面，`openapi.yaml` 可直接导入做路由与限流配置。
