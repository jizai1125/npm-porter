export type JobType = 'export' | 'import';

export type JobStatus =
  | 'pending'
  | 'resolving'
  | 'downloading'
  | 'zipping'
  | 'publishing'
  | 'done'
  | 'partial'
  | 'failed';

export interface ExportTarget {
  os: string;
  cpu: string;
  libc?: string;
}

export interface PackageRequest {
  name: string;
  version: string;
}

export interface ResolvedPackage {
  name: string;
  version: string;
  resolved: string;
  integrity?: string;
  shasum?: string;
  tarball?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface ManifestV1 {
  schemaVersion: 1;
  exportedAt: string;
  sourceRegistry: string;
  targets: ExportTarget[];
  rootPackages: PackageRequest[];
  packages: ResolvedPackage[];
}

export interface ExportRequestInput {
  source: 'manual' | 'lockfile' | 'packageJson';
  registry?: string;
  targets?: ExportTarget[];
  packages?: PackageRequest[];
  lockfileText?: string;
  packageJsonText?: string;
}

export interface ExportJob {
  id: string;
  type: 'export';
  status: JobStatus;
  progress: number;
  total: number;
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  manifest?: ManifestV1;
  zipPath?: string;
  downloadUrl?: string;
}

export interface ImportPackageResult {
  name: string;
  version: string;
  status: 'pending' | 'publishing' | 'success' | 'failed' | 'skipped';
  error?: string;
}

export interface ImportJob {
  id: string;
  type: 'import';
  status: JobStatus;
  progress: number;
  total: number;
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  manifest?: ManifestV1;
  zipPath?: string;
  results: ImportPackageResult[];
}

export type Job = ExportJob | ImportJob;

export interface RegistryConfig {
  id: string;
  name: string;
  registry: string;
  scopes?: string[];
  authType: 'token' | 'basic' | 'none';
}

export interface PublishCredentials {
  token?: string;
  username?: string;
  password?: string;
}

export interface ImportRequestInput {
  registry: string;
  registryId?: string;
  authType: 'token' | 'basic' | 'none';
  credentials: PublishCredentials;
}

export interface RegistryTestResult {
  ok: boolean;
  message: string;
}


