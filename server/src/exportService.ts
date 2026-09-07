import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import type { AppConfig } from './config.js';
import type { ExportJob, ExportRequestInput, ExportTarget, ManifestV1, PackageRequest, ResolvedPackage } from './types.js';
import { JobStore } from './jobs.js';
import {
  downloadTarball,
  parseLockfile,
  runNpmInstallLockOnly,
  sanitizePackageName,
  trimRegistry
} from './npm.js';

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function parsePackageJson(text: string): PackageJsonLike {
  return JSON.parse(text) as PackageJsonLike;
}

function rootFromPackageJson(pkg: PackageJsonLike): PackageRequest[] {
  const entries: PackageRequest[] = [];
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    entries.push({ name, version: version ?? 'latest' });
  }
  for (const [name, version] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (!entries.some((item) => item.name === name)) {
      entries.push({ name, version: version ?? 'latest' });
    }
  }
  return entries;
}

function rootFromLockfile(text: string): PackageRequest[] {
  const lock = JSON.parse(text) as {
    packages?: Record<string, PackageJsonLike>;
    dependencies?: Record<string, { version?: string }>;
  };
  if (lock.packages?.['']) {
    return rootFromPackageJson(lock.packages['']);
  }
  if (lock.dependencies) {
    return Object.entries(lock.dependencies).map(([name, entry]) => ({
      name,
      version: entry.version ?? 'latest'
    }));
  }
  return [];
}

function resolveRoots(input: ExportRequestInput): PackageRequest[] {
  if (input.source === 'manual') {
    return input.packages ?? [];
  }
  if (input.source === 'packageJson' && input.packageJsonText) {
    return rootFromPackageJson(parsePackageJson(input.packageJsonText));
  }
  if (input.source === 'lockfile' && input.lockfileText) {
    return rootFromLockfile(input.lockfileText);
  }
  return [];
}

function mergePackages(lists: ResolvedPackage[][]): ResolvedPackage[] {
  const map = new Map<string, ResolvedPackage>();
  for (const list of lists) {
    for (const item of list) {
      const key = `${item.name}@${item.version}`;
      if (!map.has(key)) {
        map.set(key, item);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function writePackageJson(cwd: string, roots: PackageRequest[]): void {
  const dependencies: Record<string, string> = {};
  for (const root of roots) {
    dependencies[root.name] = root.version || 'latest';
  }
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'npm-porter-export', version: '0.0.0', private: true, dependencies }, null, 2),
    'utf8'
  );
}

function buildLockfile(roots: PackageRequest[], packages: ResolvedPackage[]): string {
  const packageEntries: Record<string, unknown> = {
    '': {
      name: 'npm-porter-export',
      version: '0.0.0',
      dependencies: Object.fromEntries(roots.map((item) => [item.name, item.version || 'latest']))
    }
  };
  for (const item of packages) {
    packageEntries[`node_modules/${item.name}`] = {
      name: item.name,
      version: item.version,
      resolved: item.resolved,
      integrity: item.integrity,
      dependencies: item.dependencies,
      optionalDependencies: item.optionalDependencies
    };
  }
  return JSON.stringify(
    {
      name: 'npm-porter-export',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: packageEntries
    },
    null,
    2
  );
}

export async function runExportJob(input: {
  job: ExportJob;
  data: ExportRequestInput;
  store: JobStore;
  config: AppConfig;
}): Promise<void> {
  const { job, data, store, config } = input;
  const registry = trimRegistry(data.registry || config.defaultUpstreamRegistry);
  const targets: ExportTarget[] =
    data.targets && data.targets.length > 0
      ? data.targets
      : [
          { os: 'linux', cpu: 'x64' },
          { os: 'win32', cpu: 'x64' }
        ];

  try {
    store.update(job.id, { status: 'resolving', progress: 0, total: 0, message: '正在解析依赖…' });
    const roots = resolveRoots(data);
    if (roots.length === 0) {
      throw new Error('没有可导出的依赖，请选择包或上传有效的 package.json / lockfile');
    }

    const workDir = path.join(config.dataDir, 'work', job.id);
    fs.mkdirSync(workDir, { recursive: true });

    const perTarget: ResolvedPackage[][] = [];
    for (const [index, target] of targets.entries()) {
      store.update(job.id, {
        message: `正在解析目标平台 ${target.os}/${target.cpu}（${index + 1}/${targets.length}）`
      });
      const targetDir = path.join(workDir, `target-${index}`);
      fs.mkdirSync(targetDir, { recursive: true });
      writePackageJson(targetDir, roots);
      if (data.source === 'lockfile' && data.lockfileText) {
        fs.writeFileSync(path.join(targetDir, 'package-lock.json'), data.lockfileText, 'utf8');
      }
      await runNpmInstallLockOnly({ cwd: targetDir, target, registry });
      perTarget.push(parseLockfile(path.join(targetDir, 'package-lock.json')));
    }

    const packages = mergePackages(perTarget);
    store.update(job.id, {
      status: 'downloading',
      total: packages.length,
      progress: 0,
      message: '正在下载并校验 tarball…'
    });

    const tarballDir = path.join(workDir, 'tarballs');
    for (const [index, pkg] of packages.entries()) {
      const filePath = await downloadTarball(pkg, tarballDir);
      pkg.tarball = path.basename(filePath);
      pkg.shasum = undefined;
      store.update(job.id, {
        progress: index + 1,
        total: packages.length,
        message: `正在下载 ${pkg.name}@${pkg.version}（${index + 1}/${packages.length}）`
      });
    }

    store.update(job.id, { status: 'zipping', message: '正在生成 zip…' });
    const manifest: ManifestV1 = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceRegistry: registry,
      targets,
      rootPackages: roots,
      packages
    };
    fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(workDir, 'package-lock.json'),
      data.lockfileText || buildLockfile(roots, packages),
      'utf8'
    );

    fs.mkdirSync(path.join(config.dataDir, 'exports'), { recursive: true });
    const zipPath = path.join(config.dataDir, 'exports', `${job.id}.zip`);
    await createZip(workDir, zipPath, job.id);

    store.update(job.id, {
      status: 'done',
      progress: packages.length,
      total: packages.length,
      message: '导出完成',
      manifest,
      zipPath,
      downloadUrl: `/api/exports/${job.id}/download`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.update(job.id, { status: 'failed', message: '导出失败', error: message });
  }
}

function createZip(workDir: string, zipPath: string, jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    const tarballDir = path.join(workDir, 'tarballs');
    archive.directory(tarballDir, 'tarballs');
    archive.file(path.join(workDir, 'manifest.json'), { name: 'manifest.json' });
    archive.file(path.join(workDir, 'package-lock.json'), { name: 'package-lock.json' });
    archive.finalize().catch(reject);
  });
}

