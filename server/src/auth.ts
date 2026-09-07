import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config.js';

export const SESSION_COOKIE_NAME = 'npm_porter_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type LoginMethod = 'password' | 'verdaccio';

export interface SessionRecord {
  id: string;
  loginMethod: LoginMethod;
  username?: string;
  expiresAt: number;
}

export interface SessionState {
  enabled: boolean;
  authenticated: boolean;
  methods: LoginMethod[];
  loginMethod?: LoginMethod;
  username?: string;
  verdaccioUrl?: string;
}

export type LoginInput =
  | { method: 'password'; password: string }
  | { method: 'verdaccio'; username: string; password: string };

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function now(): number {
  return Date.now();
}

export class AuthService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly failedLogins = new Map<string, { count: number; windowStartedAt: number }>();

  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.auth.enabled;
  }

  get methods(): LoginMethod[] {
    if (!this.enabled) return [];
    const methods: LoginMethod[] = [];
    if (this.config.auth.password) methods.push('password');
    if (this.config.auth.verdaccioUrl) methods.push('verdaccio');
    return methods;
  }

  supportsMethod(method: LoginMethod): boolean {
    return this.methods.includes(method);
  }

  get cookieSecure(): boolean {
    return this.config.auth.cookieSecure;
  }

  get verdaccioUrl(): string | undefined {
    return this.config.auth.verdaccioUrl;
  }

  createSession(loginMethod: LoginMethod, username?: string): SessionRecord {
    this.removeExpiredSessions();
    const session: SessionRecord = {
      id: randomUUID(),
      loginMethod,
      username,
      expiresAt: now() + SESSION_TTL_SECONDS * 1000
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string | undefined): SessionRecord | undefined {
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  destroySession(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  getState(sessionId: string | undefined): SessionState {
    if (!this.enabled) {
      return {
        enabled: false,
        authenticated: true,
        methods: []
      };
    }

    const session = this.getSession(sessionId);
    return {
      enabled: true,
      authenticated: Boolean(session),
      methods: this.methods,
      loginMethod: session?.loginMethod,
      username: session?.username,
      verdaccioUrl: this.verdaccioUrl
    };
  }

  async authenticate(input: LoginInput): Promise<{ ok: true } | { ok: false; status: number }> {
    if (input.method === 'password') {
      const expected = this.config.auth.password ?? '';
      return safeEqual(expected, input.password)
        ? { ok: true }
        : { ok: false, status: 401 };
    }

    if (input.method === 'verdaccio') {
      return this.verifyVerdaccio(input.username, input.password);
    }

    return { ok: false, status: 400 };
  }

  isRateLimited(ip: string): boolean {
    const entry = this.failedLogins.get(ip);
    if (!entry) return false;
    if (now() - entry.windowStartedAt >= 60_000) {
      this.failedLogins.delete(ip);
      return false;
    }
    return entry.count >= 5;
  }

  recordFailedLogin(ip: string): void {
    const entry = this.failedLogins.get(ip);
    if (!entry || now() - entry.windowStartedAt >= 60_000) {
      this.failedLogins.set(ip, { count: 1, windowStartedAt: now() });
      return;
    }
    entry.count += 1;
  }

  resetFailedLogins(ip: string): void {
    this.failedLogins.delete(ip);
  }

  private async verifyVerdaccio(
    username: string,
    password: string
  ): Promise<{ ok: true } | { ok: false; status: number }> {
    const baseUrl = this.config.auth.verdaccioUrl;
    if (!baseUrl) {
      return { ok: false, status: 503 };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${baseUrl}/-/whoami`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
        },
        signal: controller.signal
      });
      if (response.ok) {
        try {
          const data = (await response.json()) as { username?: unknown };
          if (typeof data.username === 'string' && data.username === username) {
            return { ok: true };
          }
        } catch {
          // 无有效响应体时按认证失败处理
        }
        return { ok: false, status: 401 };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: 401 };
      }
      return { ok: false, status: 502 };
    } catch {
      return { ok: false, status: 503 };
    } finally {
      clearTimeout(timeout);
    }
  }

  private removeExpiredSessions(): void {
    const current = now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= current) {
        this.sessions.delete(id);
      }
    }
  }
}
