import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ExportTarget, ResolvedPackage } from './types.js';

export interface NpmSearchResult {
  name: string;
  version: string;
  description?: string;
}

export function trimRegistry(registry: string): string {
  return registry.replace(/\/+$/, '');
}

export function packageUrl(registry: string, name: string): string {
  return `${trimRegistry(registry)}/${name.replace('/', '%2f')}`;
}

export async function searchPackages(registry: string, text: string, size = 20): Promise<NpmSearchResult[]> {
  const url = `${trimRegistry(registry)}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`搜索失败：${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as {
    objects?: Array<{ package?: { name?: string; version?: string; description?: string } }>;
  };
  return (data.objects ?? []).flatMap((item) => {
    const pkg = item.package;
    if (!pkg?.name) return [];
    return [{ name: pkg.name, version: pkg.version ?? '', description: pkg.description }];
  });
}

export async function getPackument(registry: string, name: string): Promise<unknown> {
  const response = await fetch(packageUrl(registry, name));
  if (!response.ok) {
    throw new Error(`获取包信息失败：${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function runNpmInstallLockOnly(input: {
  cwd: string;
  target: ExportTarget;
  registry: string;
}): Promise<void> {
  const args = [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--omit=dev',
    '--omit=peer',
    `--os=${input.target.os}`,
    `--cpu=${input.target.cpu}`,
    ...(input.target.libc ? [`--libc=${input.target.libc}`] : []),
    '--no-audit',
    '--no-fund',
    `--registry=${trimRegistry(input.registry)}`
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: input.cwd,
      env: process.env,
      shell: process.platform === 'win32'
    });
    let stderr = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install 失败：${stderr || `exit ${code}`}`));
      }
    });
  });
}

interface RawLockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function packageNameFromPath(key: string): string | undefined {
  const parts = key.split('/').filter(Boolean);
  if (parts[0] === 'node_modules') {
    parts.shift();
  }
  if (parts.length === 0) return undefined;
  if (parts.length >= 2 && parts[0].startsWith('@')) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function normalizeRawPackage(name: string | undefined, pkg: RawLockPackage): ResolvedPackage | undefined {
  const resolvedName = name ?? pkg.name;
  if (!resolvedName || !pkg.version || pkg.link || !pkg.resolved || pkg.dev) {
    return undefined;
  }
  return {
    name: resolvedName,
    version: pkg.version,
    resolved: pkg.resolved,
    integrity: pkg.integrity,
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies
  };
}

function flattenV1(deps: Record<string, RawLockPackage> | undefined, result: ResolvedPackage[]): void {
  if (!deps) return;
  for (const [name, pkg] of Object.entries(deps)) {
    const normalized = normalizeRawPackage(name, pkg);
    if (normalized) result.push(normalized);
    flattenV1(pkg.dependencies as Record<string, RawLockPackage> | undefined, result);
  }
}

export function parseLockfile(filePath: string): ResolvedPackage[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lock = JSON.parse(raw) as {
    lockfileVersion?: number;
    packages?: Record<string, RawLockPackage>;
    dependencies?: Record<string, RawLockPackage>;
  };
  const result: ResolvedPackage[] = [];

  if (lock.packages && typeof lock.packages === 'object') {
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (!key) continue;
      const normalized = normalizeRawPackage(packageNameFromPath(key), pkg);
      if (normalized) result.push(normalized);
    }
  }

  if (lock.dependencies && typeof lock.dependencies === 'object') {
    flattenV1(lock.dependencies, result);
  }

  const seen = new Set<string>();
  return result.filter((item) => {
    const key = `${item.name}@${item.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sanitizePackageName(name: string): string {
  return name.replace(/[^a-zA-Z0-9@._-]/g, '_').replace('/', '__');
}

export function verifyFileIntegrity(filePath: string, integrity?: string): boolean {
  if (!integrity) return true;
  const match = integrity.trim().match(/^(sha512|sha256|sha1)-(.+)$/i);
  if (!match) return false;
  const algorithm = match[1].toLowerCase();
  const expected = match[2];
  const data = fs.readFileSync(filePath);
  if (algorithm === 'sha1') {
    return createHash('sha1').update(data).digest('hex') === expected;
  }
  const digestEncoding = algorithm === 'sha512' || algorithm === 'sha256' ? 'base64' : 'hex';
  return createHash(algorithm).update(data).digest(digestEncoding) === expected;
}

export async function downloadTarball(pkg: ResolvedPackage, destDir: string): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  const fileName = `${sanitizePackageName(pkg.name)}@${pkg.version}.tgz`;
  const filePath = path.join(destDir, fileName);

  const response = await fetch(pkg.resolved);
  if (!response.ok) {
    throw new Error(`下载 ${pkg.name}@${pkg.version} 失败：${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  if (!verifyFileIntegrity(filePath, pkg.integrity)) {
    throw new Error(`完整性校验失败：${pkg.name}@${pkg.version}`);
  }
  return filePath;
}

