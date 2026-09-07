import { createId, writeJob } from './storage.js';
import type { ExportJob, ImportJob, Job, JobStatus } from './types.js';

export class JobStore {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly dataDir: string) {}

  createExport(input: {
    status: JobStatus;
    message: string;
  }): ExportJob {
    const now = new Date().toISOString();
    const job: ExportJob = {
      id: createId(),
      type: 'export',
      status: input.status,
      progress: 0,
      total: 0,
      message: input.message,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    writeJob(this.dataDir, job);
    return job;
  }

  createImport(input: {
    status: JobStatus;
    message: string;
    zipPath?: string;
  }): ImportJob {
    const now = new Date().toISOString();
    const job: ImportJob = {
      id: createId(),
      type: 'import',
      status: input.status,
      progress: 0,
      total: 0,
      message: input.message,
      createdAt: now,
      updatedAt: now,
      zipPath: input.zipPath,
      results: []
    };
    this.jobs.set(job.id, job);
    writeJob(this.dataDir, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  update(id: string, patch: Partial<ExportJob> & Partial<ImportJob>): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    writeJob(this.dataDir, job);
    return job;
  }
}
