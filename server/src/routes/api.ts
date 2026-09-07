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

type MultipartField =
  | { kind: 'field'; value: string }
  | { kind: 'file'; value: Buffer; filename?: string };

async function readMultipart(request: FastifyRequest): Promise<Record<string, MultipartField>> {
  const result: Record<string, MultipartField> = {};
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      result[part.fieldname] = {
        kind: 'file',
        value: await part.toBuffer(),
        filename: part.filename
      };
    } else {
      result[part.fieldname] = {
        kind: 'field',
        value: String((part as { value?: unknown }).value ?? '')
      };
    }
  }
  return result;
}

function fieldValue(parts: Record<string, MultipartField>, name: string): string | undefined {
  const field = parts[name];
  return field?.kind === 'field' ? field.value : undefined;
}

function fileValue(parts: Record<string, MultipartField>, name: string): Buffer | undefined {
  const field = parts[name];
  return field?.kind === 'file' ? field.value : undefined;
}

function fileField(parts: Record<string, MultipartField>, name: string): Extract<MultipartField, { kind: 'file' }> | undefined {
  const field = parts[name];
  return field?.kind === 'file' ? field : undefined;
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
        source: fieldValue(parts, 'source') as ExportRequestInput['source'],
        registry: fieldValue(parts, 'registry'),
        targets: parseJsonField(fieldValue(parts, 'targets')) as ExportRequestInput['targets'],
        packages: parseJsonField(fieldValue(parts, 'packages')) as ExportRequestInput['packages'],
        lockfileText: fileValue(parts, 'lockfile')?.toString('utf8'),
        packageJsonText: fileValue(parts, 'packageJson')?.toString('utf8')
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
      return reply.code(400).send({ error: '请使用 multipart 上传包归档' });
    }
    const parts = await readMultipart(request);
    const uploadedFile = fileField(parts, 'file');
    const file = uploadedFile?.value;
    const registry = fieldValue(parts, 'registry');
    if (!file || !registry) {
      return reply.code(400).send({ error: '缺少包归档文件或目标 registry' });
    }

    const job = store.createImport({ status: 'pending', message: '上传完成，等待处理' });
    const extension = uploadedFile.filename ? path.extname(uploadedFile.filename).toLowerCase() : '';
    const safeExtension = ['.zip', '.tgz', '.gz'].includes(extension) ? extension : '.zip';
    const zipPath = path.join(config.dataDir, 'imports', `${job.id}${safeExtension}`);
    fs.writeFileSync(zipPath, file);
    store.update(job.id, { zipPath });

    const data: ImportRequestInput = {
      registry: trimRegistry(registry),
      authType: (fieldValue(parts, 'authType') as ImportRequestInput['authType']) || 'none',
      credentials: {
        token: fieldValue(parts, 'token'),
        username: fieldValue(parts, 'username'),
        password: fieldValue(parts, 'password')
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
