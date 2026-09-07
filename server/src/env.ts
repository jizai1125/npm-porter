import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

function resolveProjectRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '..', '..');
}

export function loadEnvFiles(): void {
  const projectRoot = resolveProjectRoot();
  const files = [path.join(projectRoot, 'server', '.env')];

  for (const file of files) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file, quiet: true });
    }
  }
}
