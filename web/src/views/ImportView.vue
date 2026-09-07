<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NProgress,
  NSelect,
  NSpace,
  NTag,
  NUpload,
  NUploadDragger,
  useMessage
} from 'naive-ui'
import type { DataTableColumns, UploadFileInfo } from 'naive-ui'
import { CloudUploadOutline } from '@vicons/ionicons5'
import { api, ApiError } from '../api'
import type { ImportJob, ImportPackageResult, RegistryConfig } from '../types'
import PageHeader from '../components/PageHeader.vue'

const message = useMessage()
const registries = ref<RegistryConfig[]>([])
const registryId = ref<string | null>(null)
const registryUrl = ref('http://127.0.0.1:4873')
const authType = ref<'token' | 'basic' | 'none'>('none')
const token = ref('')
const username = ref('')
const password = ref('')
const uploadFile = ref<File | null>(null)
const importJob = ref<ImportJob | null>(null)

const uploadFileName = computed(() => uploadFile.value?.name ?? '')

const summaryRegistry = computed(() => {
  const selected = registries.value.find((item) => item.id === registryId.value)
  return selected ? `${selected.name}（${selected.registry}）` : registryUrl.value || '未选择'
})

const authLabel = computed(() => {
  if (authType.value === 'token') return 'Token'
  if (authType.value === 'basic') return '用户名 / 密码'
  return '匿名'
})

let pollTimer: ReturnType<typeof setInterval> | undefined

const registryOptions = computed(() =>
  registries.value.map((item) => ({ label: `${item.name}（${item.registry}）`, value: item.id }))
)

const progressPercent = computed(() => {
  if (!importJob.value || importJob.value.total <= 0) return 0
  return Math.min(100, Math.round((importJob.value.progress / importJob.value.total) * 100))
})

const activeRegistryUrl = computed(() => {
  const selected = registries.value.find((item) => item.id === registryId.value)
  return selected?.registry || registryUrl.value
})

async function loadRegistries(): Promise<void> {
  try {
    registries.value = await api.listRegistries()
    if (registries.value.length > 0 && !registryId.value) {
      registryId.value = registries.value[0].id
    }
  } catch {
    message.error('加载私服配置失败')
  }
}

function handleUpload(options: { file: UploadFileInfo }): void {
  if (options.file.file) uploadFile.value = options.file.file
}

async function submitImport(): Promise<void> {
  if (!uploadFile.value) {
    message.warning('请先上传包归档')
    return
  }
  try {
    importJob.value = await api.createImport({
      registry: activeRegistryUrl.value,
      authType: authType.value,
      token: token.value || undefined,
      username: username.value || undefined,
      password: password.value || undefined,
      file: uploadFile.value
    })
    message.success('导入任务已创建')
    startPolling()
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '创建导入任务失败')
  }
}

async function retryImport(): Promise<void> {
  if (!importJob.value) return
  try {
    importJob.value = await api.retryImport(importJob.value.id, {
      registry: activeRegistryUrl.value,
      authType: authType.value,
      token: token.value || undefined,
      username: username.value || undefined,
      password: password.value || undefined
    })
    startPolling()
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '重试失败')
  }
}

function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(async () => {
    if (!importJob.value) return
    try {
      importJob.value = (await api.getJob(importJob.value.id)) as ImportJob
      if (importJob.value.status === 'done' || importJob.value.status === 'partial' || importJob.value.status === 'failed') {
        stopPolling()
      }
    } catch {
      // keep polling
    }
  }, 1000)
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

onMounted(loadRegistries)
onUnmounted(stopPolling)

const resultColumns: DataTableColumns<ImportPackageResult> = [
  { title: '包名', key: 'name', minWidth: 220 },
  { title: '版本', key: 'version', width: 140 },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render: (row) => {
      const type = row.status === 'success' ? 'success' : row.status === 'failed' ? 'error' : row.status === 'skipped' ? 'warning' : 'info'
      return h(NTag, { type, size: 'small' }, { default: () => row.status })
    }
  },
  { title: '错误信息', key: 'error', ellipsis: { tooltip: true } }
]
</script>

<template>
  <div class="import-page">
    <PageHeader title="导入发布" description="把 npm-porter 导出的离线包或单个 npm 包归档发布到目标 Verdaccio。">
      <template #extra>
        <n-tag type="warning" round size="large">
        内网模式
      </n-tag>
      </template>
    </PageHeader>

    <div class="import-layout">
      <main class="import-main">
        <n-card class="section-card">
          <template #header>
            <h3 class="section-title">导入配置</h3>
          </template>

          <n-form label-placement="top" class="import-form">
            <n-form-item label="包归档">
              <n-upload :default-upload="false" :max="1" accept=".zip,.tgz,.tar.gz" @change="handleUpload" class="zip-upload">
                <n-upload-dragger>
                  <div class="upload-inner">
                    <p>点击或拖拽包归档文件到此处</p>
                    <p class="upload-hint">支持 npm-porter 导出 zip，或单个 npm 包的 zip / tgz / tar.gz</p>
                  </div>
                </n-upload-dragger>
              </n-upload>
            </n-form-item>
            <n-form-item label="已配置私服">
              <n-select
                v-model:value="registryId"
                :options="registryOptions"
                placeholder="选择已配置私服"
                clearable
              />
            </n-form-item>
            <n-form-item label="Registry 地址">
              <n-input v-model:value="registryUrl" placeholder="http://127.0.0.1:4873" />
            </n-form-item>
            <n-form-item label="认证方式">
              <n-select
                v-model:value="authType"
                :options="[
                  { label: '匿名', value: 'none' },
                  { label: 'Token', value: 'token' },
                  { label: '用户名 / 密码', value: 'basic' }
                ]"
              />
            </n-form-item>

            <n-form-item v-if="authType === 'token'" label="访问 token">
              <n-input v-model:value="token" placeholder="输入访问 token" />
            </n-form-item>

            <div v-if="authType === 'basic'" class="credential-grid">
              <n-form-item label="用户名">
                <n-input v-model:value="username" placeholder="Verdaccio 用户名" />
              </n-form-item>
              <n-form-item label="密码">
                <n-input v-model:value="password" type="password" placeholder="Verdaccio 密码" />
              </n-form-item>
            </div>
          </n-form>
        </n-card>
      </main>

      <aside class="import-side">
        <n-card class="summary-card">
          <template #header>
            <h3 class="section-title">发布任务</h3>
          </template>

          <div class="summary-list">
            <div class="summary-item">
              <span>包归档</span>
              <strong>{{ uploadFileName || '未选择' }}</strong>
            </div>
            <div class="summary-item">
              <span>目标私服</span>
              <strong>{{ summaryRegistry }}</strong>
            </div>
            <div class="summary-item">
              <span>认证方式</span>
              <strong>{{ authLabel }}</strong>
            </div>
          </div>

          <n-button type="primary" block size="large" class="submit-button" @click="submitImport">
            <template #icon>
              <n-icon><CloudUploadOutline /></n-icon>
            </template>
            开始导入发布
          </n-button>
          <p class="summary-tip">凭据仅用于本次发布，不会保存。</p>
        </n-card>
      </aside>
    </div>

    <n-card v-if="importJob" class="job-card">
      <template #header>
        <h3 class="section-title">发布任务</h3>
      </template>

      <n-space vertical :size="12">
        <n-space align="center" justify="space-between">
          <n-tag :type="importJob.status === 'done' ? 'success' : importJob.status === 'partial' || importJob.status === 'failed' ? 'error' : 'info'">
            {{ importJob.message }}
          </n-tag>
          <n-button v-if="importJob.status === 'partial' || importJob.status === 'failed'" @click="retryImport">
            重试失败项
          </n-button>
        </n-space>
        <n-progress type="line" :percentage="progressPercent" :status="importJob.status === 'failed' ? 'error' : 'default'" />
        <n-space v-if="importJob.error">
          <n-tag type="error">失败原因</n-tag>
          <span>{{ importJob.error }}</span>
        </n-space>
        <n-data-table :columns="resultColumns" :data="importJob.results" :bordered="false" :max-height="320">
          <template #empty>
            <n-empty description="暂无发布结果" />
          </template>
        </n-data-table>
      </n-space>
    </n-card>
  </div>
</template>

<style scoped>
.import-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.page-hero h1 {
  margin: 0;
  font-size: 24px;
  letter-spacing: -0.5px;
  color: #0f172a;
}

.page-hero p {
  margin: 6px 0 0;
  color: #64748b;
  font-size: 14px;
}

.import-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}

.import-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.section-title {
  margin: 0;
  font-size: 16px;
  color: #0f172a;
}

.zip-upload {
  width: 100%;
}

.zip-upload .n-upload-dragger {
  padding: 0;
}

.upload-inner {
  padding: 28px 16px;
  text-align: center;
  color: #64748b;
}

.upload-inner p {
  margin: 10px 0 0;
}

.upload-hint {
  color: #94a3b8;
  font-size: 13px;
}

.import-form {
  margin-top: 0;
}

.credential-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.import-side {
  min-width: 0;
}

.summary-card {
  position: sticky;
  top: 16px;
}

.summary-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.summary-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
}

.summary-item span {
  color: #64748b;
  flex: none;
}

.summary-item strong {
  color: #0f172a;
  text-align: right;
  word-break: break-all;
}

.submit-button {
  margin-top: 4px;
}

.summary-tip {
  margin: 12px 0 0;
  color: #94a3b8;
  font-size: 12px;
  text-align: center;
}

@media (max-width: 768px) {
  .page-hero {
    align-items: flex-start;
    flex-direction: column;
  }

  .import-layout {
    grid-template-columns: 1fr;
  }

  .summary-card {
    position: static;
  }

}
</style>
