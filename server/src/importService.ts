import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
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
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      throw new Error(`拒绝不支持的 zip 条目：${entryPath}`);
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

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = await new Promise<Array<{ path: string; type: string }>>((resolve, reject) => {
    const collected: Array<{ path: string; type: string }> = [];
    tar
      .t({
        file: archivePath,
        strict: true,
        onentry: (entry) => collected.push({ path: entry.path, type: entry.type })
      })
      .then(() => resolve(collected))
      .catch(reject);
  });

  for (const entry of entries) {
    if (isPathTraversal(entry.path)) {
      throw new Error(`拒绝不安全的 tar 路径：${entry.path}`);
    }
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      throw new Error(`拒绝不支持的 tar 条目：${entry.path}`);
    }
  }

  await tar.x({
    file: archivePath,
    cwd: destDir,
    strict: true
  });
}

function isPorterArchive(destDir: string): boolean {
  const manifestPath = path.join(destDir, 'manifest.json');
  const tarballDir = path.join(destDir, 'tarballs');
  return (
    fs.existsSync(manifestPath) &&
    fs.existsSync(tarballDir) &&
    fs.statSync(tarballDir).isDirectory()
  );
}

function locatePackageRoot(destDir: string): string {
  if (fs.existsSync(path.join(destDir, 'package.json'))) {
    return destDir;
  }

  const entries = fs.readdirSync(destDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const candidates = entries
    .map((entry) => path.join(destDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')));

  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new Error('压缩包包含多个包目录，请分别上传或使用 npm-porter 导出 zip');
  }
  throw new Error('压缩包中未找到 package.json');
}

function readPackageIdentity(pkgRoot: string): { name: string; version: string; scoped: boolean } {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof pkg.name !== 'string' || !pkg.name.trim()) {
    throw new Error('package.json 缺少有效的 name');
  }
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error('package.json 缺少有效的 version');
  }
  const name = pkg.name.trim();
  const version = pkg.version.trim();
  return { name, version, scoped: name.startsWith('@') };
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

async function publishPackage(input: {
  publishPath: string;
  registry: string;
  npmrcPath: string;
  scoped: boolean;
}): Promise<void> {
  const args = [
    'publish',
    input.publishPath,
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

function detectArchiveKind(archivePath: string): 'zip' | 'tgz' {
  const fd = fs.openSync(archivePath, 'r');
  const header = Buffer.alloc(4);
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header[0] === 0x1f && header[1] === 0x8b) return 'tgz';
  if (header[0] === 0x50 && header[1] === 0x4b) return 'zip';
  throw new Error('不支持的归档格式，仅支持 zip / tgz / tar.gz');
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (detectArchiveKind(archivePath) === 'tgz') {
    await extractTarGz(archivePath, destDir);
    return;
  }
  await extractZip(archivePath, destDir);
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
      throw new Error('上传的归档文件不存在或已丢失');
    }
    store.update(job.id, { status: 'publishing', progress: 0, total: 0, message: '正在解包并校验…' });

    const workDir = path.join(config.dataDir, 'work', job.id, 'import');
    await extractArchive(job.zipPath, workDir);

    npmrcPath = path.join(config.dataDir, 'work', job.id, '.npmrc');
    fs.writeFileSync(npmrcPath, buildNpmrc(data), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(npmrcPath, 0o600);

    if (isPorterArchive(workDir)) {
      const manifest = readManifest(workDir);
      verifyManifestTarballs(workDir, manifest);
      const ordered = topologicalSort(manifest.packages);
      store.update(job.id, {
        manifest,
        total: ordered.length,
        progress: 0,
        message: `校验通过，准备发布 ${ordered.length} 个包`
      });

      let failed = 0;
      for (const [index, pkg] of ordered.entries()) {
        const fileName = pkg.tarball || `${pkg.name.replace('/', '__')}@${pkg.version}.tgz`;
        const publishPath = path.join(workDir, 'tarballs', fileName);
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
          await publishPackage({ publishPath, registry: data.registry, npmrcPath, scoped });
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
      return;
    }

    const pkgRoot = locatePackageRoot(workDir);
    const identity = readPackageIdentity(pkgRoot);
    store.update(job.id, {
      total: 1,
      progress: 0,
      message: `校验通过，准备发布 ${identity.name}@${identity.version}`
    });

    const resultEntry = job.results.find((item) => item.name === identity.name && item.version === identity.version) ?? {
      name: identity.name,
      version: identity.version,
      status: 'pending'
    };
    resultEntry.status = 'publishing';
    store.update(job.id, {
      progress: 0,
      message: `正在发布 ${identity.name}@${identity.version}`,
      results: [...job.results.filter((item) => !(item.name === identity.name && item.version === identity.version)), resultEntry]
    });

    let failed = 0;
    try {
      await publishPackage({ publishPath: pkgRoot, registry: data.registry, npmrcPath, scoped: identity.scoped });
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
      status: failed === 0 ? 'done' : 'partial',
      progress: 1,
      total: 1,
      message: failed === 0 ? '发布完成' : `发布完成，${failed} 个包失败`,
      results: [...job.results.filter((item) => !(item.name === identity.name && item.version === identity.version)), resultEntry]
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


