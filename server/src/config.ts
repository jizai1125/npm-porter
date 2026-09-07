import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRegistries } from './storage.js';

export interface AuthConfig {
  enabled: boolean;
  password?: string;
  verdaccioUrl?: string;
  sessionSecret: string;
  cookieSecure: boolean;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  defaultUpstreamRegistry: string;
  maxUploadMb: number;
  auth: AuthConfig;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaultDataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  const dataDir = env.DATA_DIR ?? defaultDataDir;
  const authEnabled = readBool(env.AUTH_ENABLED, false);
  const password = env.AUTH_PASSWORD;

  let verdaccioUrl = normalizeBaseUrl(env.AUTH_VERDACCIO_URL);
  if (authEnabled && !password && !verdaccioUrl) {
    verdaccioUrl = normalizeBaseUrl(readRegistries(dataDir)[0]?.registry);
  }
  if (authEnabled && !password && !verdaccioUrl) {
    throw new Error('开启登录时必须配置 AUTH_PASSWORD 或 AUTH_VERDACCIO_URL，或至少存在一个私服 registry');
  }

  return {
    port: readPositiveInt(env.PORT, 3000),
    dataDir,
    defaultUpstreamRegistry: env.DEFAULT_UPSTREAM_REGISTRY ?? 'https://registry.npmjs.org',
    maxUploadMb: readPositiveInt(env.MAX_UPLOAD_MB, 512),
    auth: {
      enabled: authEnabled,
      password,
      verdaccioUrl,
      sessionSecret: env.AUTH_SESSION_SECRET || randomBytes(32).toString('hex'),
      cookieSecure: readBool(env.AUTH_COOKIE_SECURE, false)
    }
  };
}
