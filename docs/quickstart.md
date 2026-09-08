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

### Telegram 私人号（userbot，MTProto）

需要以真人账号身份收发（进群读消息、主动私信陌生人等 bot 做不到的事）时用 `telegram-user` 通道，基于 GramJS 的 MTProto 实现：

```ts
import { createPrism } from "@prism/sdk";

const prism = createPrism({
  channels: {
    "telegram-user": {
      apiId: Number(process.env.TG_API_ID!),   // https://my.telegram.org → API development tools
      apiHash: process.env.TG_API_HASH!,
      phoneNumber: "+8613800000000",
      // 首次登录需要验证码，由你的系统提供（接短信/用户输入）
      codeProvider: async () => await getLoginCodeFromSomewhere(),
      // 2FA 密码（如果账号设置了两步验证）
      password: process.env.TG_2FA_PASSWORD,
      // 登录成功后回调 StringSession——务必持久化，下次启动直接传 session 免登录
      onSessionSaved: async (session) => saveToDb("tg-user-session", session),
    },
  },
});
```

```bash
pnpm add telegram input   # MTProto 运行时（可选依赖，用到才装）
```

> ⚠️ **合规风险**：程序化操作个人账号违反 Telegram 服务条款，可能导致封号且不可申诉。生产环境优先使用 bot 形态（`telegram` 通道）；私人号仅用于合规允许的场景并自担风险。

### 需要登录/会过期的凭证（LINE / WhatsApp / Gmail OAuth 等）

静态 token 会过期。凡是官方要求"登录获取"的凭证，都可以传入 `CredentialProvider`，由你的外部系统实现登录逻辑，Prism 负责缓存、过期刷新和 401 自动重登：

```ts
import { createPrism, OAuthCredentialProvider, text } from "@prism/sdk";

const prism = createPrism({
  channels: {
    line: {
      // 字符串（原样保留）或凭证提供者二选一
      channelAccessToken: new OAuthCredentialProvider({
        tokenUrl: "https://api.line.me/v2/oauth/accessToken",
        clientId: process.env.LINE_CHANNEL_ID!,
        clientSecret: process.env.LINE_CHANNEL_SECRET!,
        // LINE 的响应是 query-string 形式，需要自定义解析
        parseResponse: (body) => {
          const b = body as { access_token?: string; expires_in?: string };
          return {
            accessToken: b.access_token,
            ...(b.expires_in
              ? { expiresAt: Date.now() + Number(b.expires_in) * 1000 }
              : {}),
          };
        },
      }),
      channelSecret: process.env.LINE_CHANNEL_SECRET!,
    },
    whatsapp: {
      phoneNumberId: "123456789",
      accessToken: new OAuthCredentialProvider({
        tokenUrl: "https://graph.facebook.com/oauth/access_token",
        clientId: process.env.META_APP_ID!,
        clientSecret: process.env.META_APP_SECRET!,
      }),
      // 入站 webhook 签名校验（X-Hub-Signature-256），强烈建议生产环境配置
      appSecret: process.env.META_APP_SECRET!,
    },
    email: {
      fromAddress: "bot@your-gmail-workspace.com",
      smtp: {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        oauth2: {
          user: "bot@your-gmail-workspace.com",
          provider: new OAuthCredentialProvider({
            tokenUrl: "https://oauth2.googleapis.com/token",
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            extraParams: { refresh_token: process.env.GOOGLE_REFRESH_TOKEN! },
          }),
        },
      },
    },
  },
});
```

自定义登录（SSO、浏览器跳转拿 token、密钥管理服务……）只需实现接口：

```ts
import type { CredentialProvider } from "@prism/sdk";

const myLogin: CredentialProvider = {
  async get() {
    /* 返回缓存的 { accessToken, expiresAt } */
  },
  async refresh() {
    /* 执行真正的登录，返回新凭证 */
  },
  isFresh(c) {
    return !!c.accessToken && (c.expiresAt ?? Infinity) - Date.now() > 30_000;
  },
};
```

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

> 非 Node.js 项目（Go / Java / Python / PHP / Rust…）不需要 SDK：网关 + [openapi.yaml](./openapi.yaml) 就是语言无关的标准接入方式，见 [non-node-integration.md](./non-node-integration.md)。

## 3. 下一步

- 架构与设计原则：[architecture.md](./architecture.md)
- 编写新平台适配器：[adapter-guide.md](./adapter-guide.md)
