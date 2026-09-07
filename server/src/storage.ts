import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, RegistryConfig } from './types.js';

export function ensureDataDirs(dataDir: string): void {
  for (const dir of ['jobs', 'exports', 'imports', 'work']) {
    fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  }
}

export function readRegistries(dataDir: string): RegistryConfig[] {
  const file = path.join(dataDir, 'registries.json');
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRegistries(dataDir: string, registries: RegistryConfig[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'registries.json'), JSON.stringify(registries, null, 2), 'utf8');
}

export function writeJob(dataDir: string, job: Job): void {
  fs.mkdirSync(path.join(dataDir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'jobs', `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
}

export function createId(): string {
  return randomUUID();
}
