import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import type { AppConfig } from './config.js';
import type { ImportJob, ImportRequestInput, ManifestV1, ResolvedPackage } from './types.js';
import { JobStore } from './jobs.js';
import { verifyFileIntegrity } from './npm.js';

function isPathTraversal(entryPath: string): boolean {
  if (path.isAbsolute(entryPath)) return true;
  const normalized = entryPath.replace(/\\/g, '/');
  return normalized.split('/').some((segment) => segment === '..');
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    const entryPath = entry.path;
    if (isPathTraversal(entryPath)) {
      throw new Error(`拒绝不安全的 zip 路径：${entryPath}`);
    }
    const targetPath = path.join(destDir, entryPath);
    if (entry.type === 'Directory') {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await pipeline(entry.stream(), createWriteStream(targetPath));
  }
}

function readManifest(destDir: string): ManifestV1 {
  const manifestPath = path.join(destDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('zip 缺少 manifest.json');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestV1;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
    throw new Error('manifest 格式不受支持');
  }
  return manifest;
}

function verifyManifestTarballs(destDir: string, manifest: ManifestV1): void {
  const tarballDir = path.join(destDir, 'tarballs');
  for (const pkg of manifest.packages) {
    const fileName = pkg.tarball || `${pkg.name.replace('/', '__')}@${pkg.version}.tgz`;
    const filePath = path.join(tarballDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`zip 缺少 tarball：${fileName}`);
    }
    if (!verifyFileIntegrity(filePath, pkg.integrity)) {
      throw new Error(`tarball 完整性校验失败：${pkg.name}@${pkg.version}`);
    }
  }
}

function topologicalSort(packages: ResolvedPackage[]): ResolvedPackage[] {
  const keyOf = (item: ResolvedPackage) => `${item.name}@${item.version}`;
  const byName = new Map<string, ResolvedPackage[]>();
  const byKey = new Map<string, ResolvedPackage>();
  for (const item of packages) {
    byKey.set(keyOf(item), item);
    const list = byName.get(item.name) ?? [];
    list.push(item);
    byName.set(item.name, list);
  }

  const edges = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const item of packages) {
    const key = keyOf(item);
    edges.set(key, new Set());
    indegree.set(key, 0);
  }

  for (const item of packages) {
    const key = keyOf(item);
    const dependencies = { ...(item.dependencies ?? {}), ...(item.optionalDependencies ?? {}) };
    for (const depName of Object.keys(dependencies)) {
      const candidates = byName.get(depName) ?? [];
      const exact = candidates.find((candidate) => candidate.version === dependencies[depName]);
      const target = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (target) {
        const targetKey = keyOf(target);
        const deps = edges.get(targetKey);
        if (deps && !deps.has(key)) {
          deps.add(key);
          indegree.set(key, (indegree.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const queue = Array.from(byKey.values()).filter((item) => (indegree.get(keyOf(item)) ?? 0) === 0);
  const sorted: ResolvedPackage[] = [];
  const queued = new Set(queue.map(keyOf));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    sorted.push(current);
    for (const nextKey of edges.get(keyOf(current)) ?? []) {
      const nextDegree = (indegree.get(nextKey) ?? 1) - 1;
      indegree.set(nextKey, nextDegree);
      if (nextDegree === 0 && !queued.has(nextKey)) {
        const next = byKey.get(nextKey);
        if (next) {
          queue.push(next);
          queued.add(nextKey);
        }
      }
    }
  }

  return sorted.length === packages.length ? sorted : packages;
}

function buildNpmrc(input: ImportRequestInput): string {
  const registry = input.registry.replace(/\/+$/, '');
  const url = new URL(registry);
  const scope = url.pathname === '/' ? '/' : url.pathname.replace(/\/?$/, '/');
  const key = `//${url.host}${scope}`;
  const lines = [`registry=${registry}`];
  if (input.authType === 'token' && input.credentials.token) {
    lines.push(`${key}:_authToken=${input.credentials.token}`);
  }
  if (input.authType === 'basic' && input.credentials.username && input.credentials.password) {
    lines.push(`${key}:username=${input.credentials.username}`);
    lines.push(`${key}:_password=${Buffer.from(input.credentials.password).toString('base64')}`);
    lines.push(`${key}:email=no-reply@npm-porter.local`);
  }
  return `${lines.join('\n')}\n`;
}

async function publishTarball(input: {
  tarballPath: string;
  registry: string;
  npmrcPath: string;
  scoped: boolean;
}): Promise<void> {
  const args = [
    'publish',
    input.tarballPath,
    `--registry=${input.registry}`,
    `--userconfig=${input.npmrcPath}`,
    '--ignore-scripts',
    ...(input.scoped ? ['--access', 'public'] : [])
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', args, {
      env: { ...process.env, NO_PROXY: `${process.env.NO_PROXY ?? ''},127.0.0.1,localhost` },
      shell: process.platform === 'win32'
    });
    let stderr = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `npm publish 退出码 ${code}`));
    });
  });
}

export async function runImportJob(input: {
  job: ImportJob;
  data: ImportRequestInput;
  store: JobStore;
  config: AppConfig;
}): Promise<void> {
  const { job, data, store, config } = input;
  let npmrcPath: string | undefined;

  try {
    if (!job.zipPath || !fs.existsSync(job.zipPath)) {
      throw new Error('上传的 zip 不存在或已丢失');
    }
    store.update(job.id, { status: 'publishing', progress: 0, total: 0, message: '正在解包并校验…' });

    const workDir = path.join(config.dataDir, 'work', job.id, 'import');
    await extractZip(job.zipPath, workDir);
    const manifest = readManifest(workDir);
    verifyManifestTarballs(workDir, manifest);

    const ordered = topologicalSort(manifest.packages);
    store.update(job.id, {
      manifest,
      total: ordered.length,
      progress: 0,
      message: `校验通过，准备发布 ${ordered.length} 个包`
    });

    npmrcPath = path.join(config.dataDir, 'work', job.id, '.npmrc');
    fs.writeFileSync(npmrcPath, buildNpmrc(data), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(npmrcPath, 0o600);

    let failed = 0;
    for (const [index, pkg] of ordered.entries()) {
      const fileName = pkg.tarball || `${pkg.name.replace('/', '__')}@${pkg.version}.tgz`;
      const tarballPath = path.join(workDir, 'tarballs', fileName);
      const scoped = pkg.name.startsWith('@');
      const resultEntry = job.results.find((item) => item.name === pkg.name && item.version === pkg.version) ?? {
        name: pkg.name,
        version: pkg.version,
        status: 'pending'
      };
      resultEntry.status = 'publishing';
      store.update(job.id, {
        progress: index,
        message: `正在发布 ${pkg.name}@${pkg.version}（${index + 1}/${ordered.length}）`,
        results: [...job.results.filter((item) => !(item.name === pkg.name && item.version === pkg.version)), resultEntry]
      });

      try {
        await publishTarball({ tarballPath, registry: data.registry, npmrcPath: npmrcPath, scoped });
        resultEntry.status = 'success';
        resultEntry.error = undefined;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('E409') || errorMessage.includes('already present') || errorMessage.includes('conflict')) {
          resultEntry.status = 'skipped';
          resultEntry.error = '目标私服已存在该版本，已跳过';
        } else {
          failed += 1;
          resultEntry.status = 'failed';
          resultEntry.error = errorMessage;
        }
      }

      store.update(job.id, {
        progress: index + 1,
        total: ordered.length,
        results: [...job.results.filter((item) => !(item.name === pkg.name && item.version === pkg.version)), resultEntry]
      });
    }

    store.update(job.id, {
      status: failed === 0 ? 'done' : 'partial',
      progress: ordered.length,
      total: ordered.length,
      message: failed === 0 ? '发布完成' : `发布完成，${failed} 个包失败`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.update(job.id, { status: 'failed', message: '导入发布失败', error: message });
  } finally {
    if (npmrcPath && fs.existsSync(npmrcPath)) {
      fs.unlinkSync(npmrcPath);
    }
  }
}


