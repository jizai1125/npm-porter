import type {
  ExportJob,
  ImportJob,
  Job,
  RegistryConfig,
  ExportTarget,
  PackageRequest,
  AuthSessionState
} from './types'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

let onUnauthorized: (() => void) | undefined

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'include' })
  if (!response.ok) {
    let message = `请求失败：${response.status}`
    try {
      const data = (await response.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // ignore non-json errors
    }
    if (response.status === 401 && !url.startsWith('/api/auth/')) {
      onUnauthorized?.()
    }
    throw new ApiError(message, response.status)
  }
  return (await response.json()) as T
}

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
}

export interface SearchResult {
  name: string
  version: string
  description?: string
}

export const api = {
  session(): Promise<AuthSessionState> {
    return request<AuthSessionState>('/api/auth/session')
  },

  login(input: { method: 'password'; password: string } | { method: 'verdaccio'; username: string; password: string }): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth/login', jsonInit(input))
  },

  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
  },

  search(text: string, size = 20): Promise<SearchResult[]> {
    return request<SearchResult[]>(`/api/search?text=${encodeURIComponent(text)}&size=${size}`)
  },

  getPackument(name: string): Promise<unknown> {
    return request<unknown>(`/api/packument?name=${encodeURIComponent(name)}`)
  },

  createExportManual(input: {
    registry: string
    targets: ExportTarget[]
    packages: PackageRequest[]
  }): Promise<ExportJob> {
    return request<ExportJob>(
      '/api/exports',
      jsonInit({ source: 'manual', ...input })
    )
  },

  createExportFile(input: {
    registry: string
    targets: ExportTarget[]
    source: 'lockfile' | 'packageJson'
    file: File
  }): Promise<ExportJob> {
    const form = new FormData()
    form.append('source', input.source)
    form.append('registry', input.registry)
    form.append('targets', JSON.stringify(input.targets))
    form.append(input.source === 'lockfile' ? 'lockfile' : 'packageJson', input.file)
    return request<ExportJob>('/api/exports', { method: 'POST', body: form })
  },

  getJob(id: string): Promise<Job> {
    return request<Job>(`/api/jobs/${id}`)
  },

  listJobs(): Promise<Job[]> {
    return request<Job[]>('/api/jobs')
  },

  downloadExport(id: string): string {
    return `/api/exports/${id}/download`
  },

  createImport(input: {
    registry: string
    authType: 'token' | 'basic' | 'none'
    token?: string
    username?: string
    password?: string
    file: File
  }): Promise<ImportJob> {
    const form = new FormData()
    form.append('registry', input.registry)
    form.append('authType', input.authType)
    if (input.token) form.append('token', input.token)
    if (input.username) form.append('username', input.username)
    if (input.password) form.append('password', input.password)
    form.append('file', input.file)
    return request<ImportJob>('/api/imports', { method: 'POST', body: form })
  },

  retryImport(id: string, input: {
    registry: string
    authType: 'token' | 'basic' | 'none'
    token?: string
    username?: string
    password?: string
  }): Promise<ImportJob> {
    return request<ImportJob>(
      `/api/imports/${id}/retry`,
      jsonInit({
        registry: input.registry,
        authType: input.authType,
        credentials: {
          token: input.token,
          username: input.username,
          password: input.password
        }
      })
    )
  },

  listRegistries(): Promise<RegistryConfig[]> {
    return request<RegistryConfig[]>('/api/registries')
  },

  createRegistry(input: Omit<RegistryConfig, 'id'>): Promise<RegistryConfig> {
    return request<RegistryConfig>('/api/registries', jsonInit(input))
  },

  updateRegistry(id: string, input: Partial<RegistryConfig>): Promise<RegistryConfig> {
    return request<RegistryConfig>(`/api/registries/${id}`, jsonInit(input, 'PUT'))
  },

  deleteRegistry(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/registries/${id}`, { method: 'DELETE' })
  },

  testRegistry(id: string, credentials?: { token?: string; username?: string; password?: string }): Promise<{ ok: boolean; message: string }> {
    return request<{ ok: boolean; message: string }>(`/api/registries/${id}/test`, jsonInit(credentials ?? {}))
  }
}
