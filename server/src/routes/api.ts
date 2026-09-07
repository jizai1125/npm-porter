import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { JobStore } from '../jobs.js';
import { ensureDataDirs, readRegistries, writeRegistries } from '../storage.js';
import type { ExportRequestInput, ImportRequestInput, RegistryConfig } from '../types.js';
import { getPackument, searchPackages, trimRegistry } from '../npm.js';
import { runExportJob } from '../exportService.js';
import { runImportJob } from '../importService.js';

function parseJsonField(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function readMultipart(request: FastifyRequest): Promise<Record<string, string | Buffer>> {
  const result: Record<string, string | Buffer> = {};
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      result[part.fieldname] = await part.toBuffer();
    } else {
      result[part.fieldname] = String((part as { value?: unknown }).value ?? '');
    }
  }
  return result;
}

export async function registerApiRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  ensureDataDirs(config.dataDir);
  const store = new JobStore(config.dataDir);

  app.get('/api/health', async () => ({
    ok: true,
    service: 'npm-porter',
    time: new Date().toISOString()
  }));

  app.get('/api/search', async (request, reply) => {
    const query = request.query as { text?: string; size?: string };
    const text = (query.text ?? '').trim();
    if (!text) {
      return reply.code(400).send({ error: '缺少搜索关键词' });
    }
    const size = Number.parseInt(query.size ?? '20', 10);
    const registry = trimRegistry(config.defaultUpstreamRegistry);
    return searchPackages(registry, text, size);
  });

  app.get('/api/packument', async (request, reply) => {
    const query = request.query as { name?: string; registry?: string };
    const name = (query.name ?? '').trim();
    if (!name) {
      return reply.code(400).send({ error: '缺少包名' });
    }
    const registry = trimRegistry(query.registry || config.defaultUpstreamRegistry);
    return getPackument(registry, name);
  });

  app.post('/api/exports', async (request, reply) => {
    let data: ExportRequestInput;
    if (request.isMultipart()) {
      const parts = await readMultipart(request);
      data = {
        source: (parts.source as string) as ExportRequestInput['source'],
        registry: parts.registry as string | undefined,
        targets: parseJsonField(parts.targets) as ExportRequestInput['targets'],
        packages: parseJsonField(parts.packages) as ExportRequestInput['packages'],
        lockfileText: parts.lockfile ? (parts.lockfile as Buffer).toString('utf8') : undefined,
        packageJsonText: parts.packageJson ? (parts.packageJson as Buffer).toString('utf8') : undefined
      };
    } else {
      data = request.body as ExportRequestInput;
    }

    const job = store.createExport({ status: 'pending', message: '任务已创建' });
    void runExportJob({ job, data, store, config }).catch(() => undefined);
    return reply.code(202).send(job);
  });

  app.get('/api/jobs', async () => store.list());

  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = store.get(id);
    if (!job) {
      return reply.code(404).send({ error: '任务不存在' });
    }
    return job;
  });

  app.get('/api/exports/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = store.get(id);
    if (!job || job.type !== 'export' || !job.zipPath || !fs.existsSync(job.zipPath)) {
      return reply.code(404).send({ error: '下载文件不存在' });
    }
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="npm-porter-${id}.zip"`);
    return reply.send(fs.createReadStream(job.zipPath));
  });

  app.post('/api/imports', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: '请使用 multipart 上传 zip' });
    }
    const parts = await readMultipart(request);
    const file = parts.file as Buffer | undefined;
    const registry = parts.registry as string | undefined;
    if (!file || !registry) {
      return reply.code(400).send({ error: '缺少 zip 文件或目标 registry' });
    }

    const job = store.createImport({ status: 'pending', message: '上传完成，等待处理' });
    const zipPath = path.join(config.dataDir, 'imports', `${job.id}.zip`);
    fs.writeFileSync(zipPath, file);
    store.update(job.id, { zipPath });

    const data: ImportRequestInput = {
      registry: trimRegistry(registry),
      authType: (parts.authType as ImportRequestInput['authType']) || 'none',
      credentials: {
        token: parts.token as string | undefined,
        username: parts.username as string | undefined,
        password: parts.password as string | undefined
      }
    };
    void runImportJob({ job, data, store, config }).catch(() => undefined);
    return reply.code(202).send(job);
  });

  app.post('/api/imports/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = store.get(id);
    if (!job || job.type !== 'import') {
      return reply.code(404).send({ error: '导入任务不存在' });
    }
    const data = request.body as ImportRequestInput;
    store.update(id, { status: 'publishing', message: '正在重试…' });
    void runImportJob({ job, data, store, config }).catch(() => undefined);
    return reply.code(202).send(job);
  });

  app.get('/api/registries', async () => readRegistries(config.dataDir));

  app.post('/api/registries', async (request, reply) => {
    const body = request.body as Partial<RegistryConfig>;
    const registries = readRegistries(config.dataDir);
    const registry: RegistryConfig = {
      id: randomUUID(),
      name: body.name?.trim() || '未命名私服',
      registry: trimRegistry(body.registry ?? ''),
      scopes: body.scopes ?? [],
      authType: body.authType ?? 'none'
    };
    if (!registry.registry) {
      return reply.code(400).send({ error: 'registry 地址不能为空' });
    }
    registries.push(registry);
    writeRegistries(config.dataDir, registries);
    return registry;
  });

  app.put('/api/registries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<RegistryConfig>;
    const registries = readRegistries(config.dataDir);
    const index = registries.findIndex((item) => item.id === id);
    if (index < 0) {
      return reply.code(404).send({ error: '私服不存在' });
    }
    registries[index] = {
      ...registries[index],
      ...body,
      id,
      registry: body.registry ? trimRegistry(body.registry) : registries[index].registry
    };
    writeRegistries(config.dataDir, registries);
    return registries[index];
  });

  app.delete('/api/registries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const registries = readRegistries(config.dataDir).filter((item) => item.id !== id);
    writeRegistries(config.dataDir, registries);
    return { ok: true };
  });

  app.post('/api/registries/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { token?: string; username?: string; password?: string } | undefined;
    const registry = readRegistries(config.dataDir).find((item) => item.id === id);
    if (!registry) {
      return reply.code(404).send({ error: '私服不存在' });
    }
    try {
      const headers: Record<string, string> = {};
      if (body?.token) headers.Authorization = `Bearer ${body.token}`;
      if (body?.username && body?.password) {
        headers.Authorization = `Basic ${Buffer.from(`${body.username}:${body.password}`).toString('base64')}`;
      }
      const response = await fetch(`${trimRegistry(registry.registry)}/-/ping`, { headers });
      return { ok: response.ok, message: response.ok ? '连接正常' : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
}
