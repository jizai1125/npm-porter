import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AuthService,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  type LoginInput
} from '../auth.js';

const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/session',
  '/api/auth/login',
  '/api/auth/logout'
]);

function readSessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : undefined;
}

function getPathname(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? request.url;
}

export function registerAuthGuard(app: FastifyInstance, auth: AuthService): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!auth.enabled || request.method === 'OPTIONS') return;

    const pathname = getPathname(request);
    if (PUBLIC_API_PATHS.has(pathname) || !pathname.startsWith('/api/')) return;

    if (!auth.getSession(readSessionId(request))) {
      return reply.code(401).send({ error: '未登录或会话已过期' });
    }
  });
}

export async function registerAuthRoutes(app: FastifyInstance, auth: AuthService): Promise<void> {
  app.get('/api/auth/session', async (request) => auth.getState(readSessionId(request)));

  app.post('/api/auth/login', async (request, reply) => {
    if (!auth.enabled) {
      return reply.code(404).send({ error: '登录未启用' });
    }

    const ip = request.ip || 'unknown';
    if (auth.isRateLimited(ip)) {
      return reply.code(429).send({ error: '失败次数过多，请稍后再试' });
    }

    const body = request.body as { method?: string; username?: string; password?: string } | undefined;
    let input: LoginInput;
    if (body?.method === 'password') {
      if (typeof body.password !== 'string' || !body.password) {
        return reply.code(400).send({ error: '请输入管理员密码' });
      }
      input = { method: 'password', password: body.password };
    } else if (body?.method === 'verdaccio') {
      if (
        typeof body.username !== 'string' ||
        !body.username ||
        typeof body.password !== 'string' ||
        !body.password
      ) {
        return reply.code(400).send({ error: '请输入 Verdaccio 用户名和密码' });
      }
      input = { method: 'verdaccio', username: body.username, password: body.password };
    } else {
      return reply.code(400).send({ error: '登录参数不完整' });
    }

    if (!auth.supportsMethod(input.method)) {
      return reply.code(400).send({ error: '该登录方式未启用' });
    }

    const result = await auth.authenticate(input);
    if (!result.ok) {
      if (result.status === 401) {
        auth.recordFailedLogin(ip);
        return reply.code(401).send({ error: '用户名或密码不正确' });
      }
      if (result.status === 502) {
        return reply.code(502).send({ error: 'Verdaccio 登录服务响应异常' });
      }
      return reply.code(503).send({ error: 'Verdaccio 登录服务不可用，请检查 AUTH_VERDACCIO_URL' });
    }

    auth.resetFailedLogins(ip);
    const session = auth.createSession(
      input.method,
      input.method === 'verdaccio' ? input.username : '管理员'
    );
    reply.setCookie(SESSION_COOKIE_NAME, session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: auth.cookieSecure,
      maxAge: SESSION_TTL_SECONDS,
      signed: true
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    auth.destroySession(readSessionId(request));
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}
