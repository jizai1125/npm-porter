<script setup lang="ts">
import { computed, h, onUnmounted, reactive, ref } from 'vue'
import {
  NButton,
  NCard,
  NCheckbox,
  NCheckboxGroup,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NProgress,
  NSelect,
  NSpace,
  NSpin,
  NTag,
  NUpload,
  NUploadDragger,
  useMessage
} from 'naive-ui'
import type { DataTableColumns, UploadFileInfo } from 'naive-ui'
import { DownloadOutline } from '@vicons/ionicons5'
import { api, ApiError, type SearchResult } from '../api'
import type { ExportJob, ExportTarget, PackageRequest } from '../types'
import PageHeader from '../components/PageHeader.vue'

const message = useMessage()

const searchText = ref('')
const searchLoading = ref(false)
const searchResults = ref<SearchResult[]>([])
const selectedPackages = ref<PackageRequest[]>([])
const versionOptions = reactive<Record<string, { label: string; value: string }[]>>({})
const registry = ref('https://registry.npmjs.org')
const inputMode = ref<'manual' | 'lockfile' | 'packageJson'>('manual')
const uploadFile = ref<File | null>(null)
const selectedPlatforms = ref<string[]>(['linux-x64', 'win32-x64'])
const exportJob = ref<ExportJob | null>(null)

const uploadFileName = computed(() => uploadFile.value?.name ?? '')

const sourceLabel = computed(() => {
  if (inputMode.value === 'manual') return `手动选包 · ${selectedPackages.value.length} 个`
  if (inputMode.value === 'lockfile') return '上传 lockfile'
  return '上传 package.json'
})

const platformLabel = computed(() => {
  const labels: Record<string, string> = {
    'linux-x64': 'Linux x64',
    'win32-x64': 'Windows x64',
    'darwin-arm64': 'macOS ARM64'
  }
  return selectedPlatforms.value.map((value) => labels[value] ?? value).join(' / ') || '未选择'
})

let pollTimer: ReturnType<typeof setInterval> | undefined

const platformOptions = [
  { label: 'Linux x64', value: 'linux-x64' },
  { label: 'Windows x64', value: 'win32-x64' },
  { label: 'macOS ARM64', value: 'darwin-arm64' }
]

const progressPercent = computed(() => {
  if (!exportJob.value || exportJob.value.total <= 0) return 0
  return Math.min(100, Math.round((exportJob.value.progress / exportJob.value.total) * 100))
})

async function doSearch(): Promise<void> {
  if (!searchText.value.trim()) {
    message.warning('请输入包名关键词')
    return
  }
  searchLoading.value = true
  try {
    searchResults.value = await api.search(searchText.value.trim())
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '搜索失败')
  } finally {
    searchLoading.value = false
  }
}

async function loadVersions(name: string): Promise<void> {
  if (versionOptions[name]) return
  try {
    const data = (await api.getPackument(name)) as {
      versions?: Record<string, unknown>
      'dist-tags'?: Record<string, string>
    }
    const latest = data['dist-tags']?.latest
    const versions = Object.keys(data.versions ?? {})
    const sortedVersions = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    const options = sortedVersions.slice(0, 100).map((version) => ({
      label: version === latest ? `${version}（latest）` : version,
      value: version
    }))
    versionOptions[name] = options
  } catch {
    versionOptions[name] = []
  }
}

function addPackage(item: SearchResult): void {
  const version = item.version || 'latest'
  if (selectedPackages.value.some((pkg) => pkg.name === item.name)) {
    message.info('该包已在导出清单中')
    return
  }
  selectedPackages.value.push({ name: item.name, version })
  void loadVersions(item.name)
}

function removePackage(name: string): void {
  selectedPackages.value = selectedPackages.value.filter((item) => item.name !== name)
}

function handleUpload(options: { file: UploadFileInfo; fileList: UploadFileInfo[] }): void {
  const raw = options.file.file
  if (raw) uploadFile.value = raw
}

function buildTargets(): ExportTarget[] {
  return selectedPlatforms.value.map((value) => {
    const [os, cpu] = value.split('-')
    return { os, cpu }
  })
}

async function submitExport(): Promise<void> {
  if (inputMode.value === 'manual' && selectedPackages.value.length === 0) {
    message.warning('请先添加要导出的包')
    return
  }
  if (inputMode.value !== 'manual' && !uploadFile.value) {
    message.warning('请先上传 lockfile 或 package.json')
    return
  }

  try {
    if (inputMode.value === 'manual') {
      exportJob.value = await api.createExportManual({
        registry: registry.value,
        targets: buildTargets(),
        packages: selectedPackages.value
      })
    } else {
      exportJob.value = await api.createExportFile({
        registry: registry.value,
        targets: buildTargets(),
        source: inputMode.value,
        file: uploadFile.value as File
      })
    }
    message.success('导出任务已创建')
    startPolling()
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '创建导出任务失败')
  }
}

function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(async () => {
    if (!exportJob.value) return
    try {
      exportJob.value = (await api.getJob(exportJob.value.id)) as ExportJob
      if (exportJob.value.status === 'done' || exportJob.value.status === 'failed') {
        stopPolling()
      }
    } catch {
      // keep polling until backend is available again
    }
  }, 1000)
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

onUnmounted(stopPolling)

const selectedColumns: DataTableColumns<PackageRequest> = [
  { title: '包名', key: 'name', minWidth: 220 },
  {
    title: '版本',
    key: 'version',
    width: 240,
    render: (row) =>
      h(NSelect, {
        value: row.version,
        options: versionOptions[row.name] ?? [],
        filterable: true,
        tag: true,
        'virtual-scroll': false,
        placeholder: '选择或输入版本',
        onUpdateValue: (value: string) => {
          row.version = value || 'latest'
        }
      })
  },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    render: (row) =>
      h(
        NButton,
        {
          size: 'small',
          quaternary: true,
          type: 'error',
          onClick: () => removePackage(row.name)
        },
        { default: () => '移除' }
      )
  }
]

const searchColumns: DataTableColumns<SearchResult> = [
  { title: '包名', key: 'name', minWidth: 220 },
  { title: '版本', key: 'version', width: 140 },
  { title: '描述', key: 'description', ellipsis: { tooltip: true } },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    render: (row) =>
      h(
        NButton,
        {
          size: 'small',
          type: 'primary',
          secondary: true,
          onClick: () => addPackage(row)
        },
        { default: () => '添加' }
      )
  }
]
</script>

<template>
  <div class="export-page">
    <PageHeader title="导出打包" description="搜索 npm 包并解析依赖，导出可离线安装的 zip。">
      <template #extra>
        <n-tag type="info" round size="large">
          外网模式
        </n-tag>
      </template>
    </PageHeader>

    <div class="export-layout">
      <main class="export-main">
        <n-card class="section-card">
          <template #header>
            <h3 class="section-title">导出配置</h3>
          </template>

          <n-form label-placement="top" class="export-form">
            <n-form-item label="导出方式">
              <div class="mode-tabs">
                <n-button :type="inputMode === 'manual' ? 'primary' : 'default'" @click="inputMode = 'manual'">
                  手动选包
                </n-button>
                <n-button :type="inputMode === 'lockfile' ? 'primary' : 'default'" @click="inputMode = 'lockfile'">
                  上传 lockfile
                </n-button>
                <n-button :type="inputMode === 'packageJson' ? 'primary' : 'default'" @click="inputMode = 'packageJson'">
                  上传 package.json
                </n-button>
              </div>
            </n-form-item>
            <n-form-item label="上游 registry">
              <n-input v-model:value="registry" placeholder="https://registry.npmjs.org" />
            </n-form-item>
            <n-form-item label="目标平台">
              <n-checkbox-group v-model:value="selectedPlatforms">
                <n-space>
                  <n-checkbox v-for="item in platformOptions" :key="item.value" :value="item.value" :label="item.label" />
                </n-space>
              </n-checkbox-group>
            </n-form-item>
          </n-form>

          <template v-if="inputMode === 'manual'">
            <div class="manual-block">
              <div class="search-row">
                <n-input v-model:value="searchText" placeholder="输入 npm 包名关键词" @keyup.enter="doSearch" />
                <n-button type="primary" :loading="searchLoading" @click="doSearch">
                  搜索
                </n-button>
              </div>

            <n-spin v-if="searchResults.length > 0" :show="searchLoading" class="result-block">
              <n-data-table
                :columns="searchColumns"
                :data="searchResults"
                  :bordered="false"
                  :max-height="240"
                  :scroll-x="760"
              >
                <template #empty>
                  <n-empty description="输入关键词后搜索 npm 包" />
                </template>
              </n-data-table>
            </n-spin>

              <n-data-table :columns="selectedColumns" :data="selectedPackages" :bordered="false" class="selected-table">
                <template #empty>
                  <n-empty description="尚未添加导出包" />
                </template>
              </n-data-table>
            </div>
          </template>

          <template v-else>
            <div class="upload-block">
              <n-upload :default-upload="false" :max="1" accept=".json,.lock,.txt" @change="handleUpload" class="file-upload">
                <n-upload-dragger>
                  <div class="upload-inner">
                    <p>点击或拖拽项目文件到此处</p>
                    <p class="upload-hint">{{ uploadFileName || '尚未选择文件' }}</p>
                  </div>
                </n-upload-dragger>
              </n-upload>
            </div>
          </template>
        </n-card>
      </main>

      <aside class="export-side">
        <n-card class="summary-card">
          <template #header>
            <h3 class="section-title">导出任务</h3>
          </template>

          <div class="summary-list">
            <div class="summary-item">
              <span>导出内容</span>
              <strong>{{ sourceLabel }}</strong>
            </div>
            <div class="summary-item">
              <span>目标平台</span>
              <strong>{{ platformLabel }}</strong>
            </div>
          </div>

          <n-button type="primary" block size="large" class="submit-button" @click="submitExport">
            <template #icon>
              <n-icon><DownloadOutline /></n-icon>
            </template>
            开始导出
          </n-button>
          <p class="summary-tip">导出任务创建后可在此页查看进度。</p>
        </n-card>
      </aside>
    </div>

    <n-card v-if="exportJob" class="job-card">
      <template #header>
        <h3 class="section-title">导出任务</h3>
      </template>

      <n-space vertical :size="12">
        <n-space align="center" justify="space-between">
          <n-tag :type="exportJob.status === 'done' ? 'success' : exportJob.status === 'failed' ? 'error' : 'info'">
            {{ exportJob.message }}
          </n-tag>
          <n-button v-if="exportJob.downloadUrl" type="primary" tag="a" :href="exportJob.downloadUrl">
            下载 zip
          </n-button>
        </n-space>
        <n-progress type="line" :percentage="progressPercent" :status="exportJob.status === 'failed' ? 'error' : 'default'" />
        <n-space v-if="exportJob.error">
          <n-tag type="error">失败原因</n-tag>
          <span>{{ exportJob.error }}</span>
        </n-space>
      </n-space>
    </n-card>
  </div>
</template>

<style scoped>
.export-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.export-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}

.export-main {
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

.mode-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.export-form {
  margin-top: 0;
}

.search-row {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}

.search-row .n-input {
  flex: 1;
}

.result-block {
  margin-bottom: 10px;
}

.manual-block,
.upload-block {
  margin-top: 16px;
}

.file-upload {
  width: 100%;
}

.file-upload .n-upload-dragger {
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
  word-break: break-all;
}

.export-side {
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
  .export-layout {
    grid-template-columns: 1fr;
  }

  .summary-card {
    position: static;
  }

  .search-row {
    flex-direction: column;
  }

}
</style>
