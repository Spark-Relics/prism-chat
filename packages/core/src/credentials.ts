/**
 * Credential management for adapters.
 *
 * Adapters that talk to platforms requiring login (LINE, WhatsApp Cloud,
 * Gmail OAuth, ...) accept a `CredentialProvider` instead of a hardcoded
 * token. External systems implement the provider with whatever login flow
 * they have (browser-based login, SSO, secret manager, custom OAuth...) and
 * Prism takes care of caching, refresh and 401 retry.
 */

/** A snapshot of credentials for one channel. */
export interface Credential {
  /** Bearer / access token used to authorize API calls. */
  accessToken?: string;
  /** Opaque refresh token, if the platform uses one. */
  refreshToken?: string;
  /** Epoch milliseconds when accessToken stops being valid. */
  expiresAt?: number;
  /** Extra fields (api keys, user ids, scopes...) for exotic providers. */
  extra?: Record<string, string>;
}

/**
 * Implemented by external systems to supply credentials.
 *
 * `get()` may be called concurrently; implementations should return a
 * cached credential when it is still fresh (see `isFresh`). Prism only
 * calls `refresh()` when a credential is missing, expired, or was
 * invalidated after an auth failure (HTTP 401/403).
 */
export interface CredentialProvider {
  /** Return a credential that is expected to work right now. */
  get(): Promise<Credential>;
  /**
   * Fetch a new credential (perform the login). Implementations should
   * update their own cache and return the new snapshot.
   */
  refresh(): Promise<Credential>;
  /** Report whether the given credential is still usable. */
  isFresh(credential: Credential): boolean;
}

/** Default freshness check: valid for at least another 30 seconds. */
export function defaultIsFresh(credential: Credential): boolean {
  if (!credential.accessToken) return false;
  if (credential.expiresAt === undefined) return true;
  return credential.expiresAt - Date.now() > 30_000;
}

/** Provider that always returns a fixed token (previous behaviour). */
export class StaticCredentialProvider implements CredentialProvider {
  private readonly credential: Credential;

  constructor(credential: Credential) {
    this.credential = credential;
  }

  /** Convenience constructor for a plain access token. */
  static token(accessToken: string): StaticCredentialProvider {
    return new StaticCredentialProvider({ accessToken });
  }

  get(): Promise<Credential> {
    return Promise.resolve(this.credential);
  }

  async refresh(): Promise<Credential> {
    return this.credential;
  }

  isFresh(credential: Credential): boolean {
    return credential.accessToken === this.credential.accessToken;
  }
}

/**
 * Generic OAuth2 client-credentials refresher.
 *
 * Works with any RFC 6749 token endpoint (Meta system-user tokens, LINE
 * channel token endpoint https://api.line.me/v2/oauth/accessToken, Gmail
 * service accounts via an exchange endpoint, Keycloak, Auth0...).
 */
export interface OAuthClientCredentials {
  /** Token endpoint URL. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional extra body params, e.g. { scope: "read write" }. */
  extraParams?: Record<string, string>;
  /** Optional custom fetch (tests / proxies). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Custom response mapper if the platform deviates from the standard. */
  parseResponse?: (body: unknown) => Credential;
}

export class OAuthCredentialProvider implements CredentialProvider {
  private readonly cfg: OAuthClientCredentials;
  private current: Credential | null = null;
  private inflight: Promise<Credential> | null = null;

  constructor(cfg: OAuthClientCredentials) {
    this.cfg = cfg;
  }

  async get(): Promise<Credential> {
    if (this.current && this.isFresh(this.current)) return this.current;
    return this.refresh();
  }

  refresh(): Promise<Credential> {
    // Single-flight: concurrent senders trigger exactly one login.
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  isFresh(credential: Credential): boolean {
    return defaultIsFresh(credential);
  }

  private async doRefresh(): Promise<Credential> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      ...(this.cfg.extraParams ?? {}),
    });
    const res = await doFetch(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`credential refresh failed: ${res.status} ${await res.text()}`);
    }
    const json: unknown = await res.json();
    const credential = this.cfg.parseResponse
      ? this.cfg.parseResponse(json)
      : this.parseStandard(json);
    this.current = credential;
    return credential;
  }

  private parseStandard(body: unknown): Credential {
    const b = body as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      ...(b.expires_in !== undefined
        ? { expiresAt: Date.now() + b.expires_in * 1000 }
        : {}),
    };
  }
}

/**
 * Wraps any provider with single-flight refresh and invalidation.
 * Adapters call `getAuthorizationHeader()` before each API call and
 * `invalidate()` when the platform answers 401/403.
 */
export class CredentialManager {
  private readonly provider: CredentialProvider;
  private current: Credential | null = null;
  private inflight: Promise<Credential> | null = null;

  constructor(provider: CredentialProvider) {
    this.provider = provider;
  }

  /** Current credential, refreshing only when stale. */
  async get(): Promise<Credential> {
    if (this.current && this.provider.isFresh(this.current)) return this.current;
    return this.refresh();
  }

  /** Force the next `get()` to login again. */
  invalidate(): void {
    this.current = null;
  }

  /** Convenience for Bearer-style APIs. */
  async getBearerToken(): Promise<string> {
    const cred = await this.get();
    if (!cred.accessToken) throw new Error("credential provider returned no accessToken");
    return cred.accessToken;
  }

  private refresh(): Promise<Credential> {
    this.inflight ??= this.provider
      .refresh()
      .then((credential) => {
        this.current = credential;
        return credential;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

/** Build a CredentialManager from either a static token or a provider. */
export function credentialManager(
  source: string | CredentialProvider
): CredentialManager {
  return new CredentialManager(
    typeof source === "string"
      ? StaticCredentialProvider.token(source)
      : source
  );
}
