<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NProgress,
  NSelect,
  NSpace,
  NTag
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '../api'
import type { ExportJob, ImportJob, Job } from '../types'
import PageHeader from '../components/PageHeader.vue'

const jobs = ref<Job[]>([])
const loading = ref(false)
const filterType = ref<string | null>(null)
const filterStatus = ref<string | null>(null)
const searchText = ref('')
const detailJob = ref<Job | null>(null)
const showDrawer = ref(false)

let timer: ReturnType<typeof setInterval> | undefined

const filteredJobs = computed(() => {
  const text = searchText.value.trim().toLowerCase()
  return jobs.value.filter((job) => {
    if (filterType.value && job.type !== filterType.value) return false
    if (filterStatus.value && job.status !== filterStatus.value) return false
    if (text && !job.id.toLowerCase().includes(text)) return false
    return true
  })
})

async function loadJobs(): Promise<void> {
  try {
    jobs.value = await api.listJobs()
  } catch {
    // keep previous list on transient errors
  }
}

function openDetail(job: Job): void {
  detailJob.value = job
  showDrawer.value = true
}

function progressOf(job: Job): number {
  if (job.total <= 0) return 0
  return Math.min(100, Math.round((job.progress / job.total) * 100))
}

function statusType(status: string): 'success' | 'error' | 'warning' | 'info' | 'default' {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'partial') return 'warning'
  return 'info'
}

onMounted(() => {
  loadJobs()
  timer = setInterval(loadJobs, 2000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const columns: DataTableColumns<Job> = [
  { title: '任务 ID', key: 'id', width: 280, ellipsis: { tooltip: true } },
  {
    title: '类型',
    key: 'type',
    width: 100,
    render: (row) => h(NTag, { size: 'small' }, { default: () => (row.type === 'export' ? '导出' : '导入') })
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) => h(NTag, { type: statusType(row.status), size: 'small' }, { default: () => row.status })
  },
  {
    title: '进度',
    key: 'progress',
    width: 160,
    render: (row) => h(NProgress, { type: 'line', percentage: progressOf(row), height: 8 })
  },
  { title: '创建时间', key: 'createdAt', width: 190 },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    render: (row) =>
      h(NSpace, { size: 8 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'small',
              secondary: true,
              onClick: () => openDetail(row)
            },
            { default: () => '详情' }
          ),
          row.type === 'export' && (row as ExportJob).downloadUrl
            ? h(
                NButton,
                {
                  size: 'small',
                  type: 'primary',
                  tag: 'a',
                  href: (row as ExportJob).downloadUrl
                },
                { default: () => '下载' }
              )
            : null
        ]
      })
  }
]
</script>

<template>
  <div class="jobs-page">
    <PageHeader title="任务记录" description="查看导出与发布任务的状态和结果。">
      <template #extra>
        <n-tag type="info" round size="large">
          自动刷新
        </n-tag>
      </template>
    </PageHeader>

    <n-card class="jobs-card">
      <template #header>
        <h3 class="section-title">任务列表</h3>
      </template>

      <n-space vertical :size="16">
        <n-space :wrap="true">
          <n-input v-model:value="searchText" placeholder="按任务 ID 搜索" clearable style="width: 240px">
          </n-input>
          <n-select v-model:value="filterType" :options="[{ label: '导出', value: 'export' }, { label: '导入', value: 'import' }]" placeholder="类型" clearable style="width: 140px" />
          <n-select v-model:value="filterStatus" :options="['pending','resolving','downloading','zipping','publishing','done','partial','failed'].map((value) => ({ label: value, value }))" placeholder="状态" clearable style="width: 160px" />
        </n-space>

        <n-data-table :columns="columns" :data="filteredJobs" :loading="loading" :bordered="false">
          <template #empty>
            <n-empty description="暂无任务" />
          </template>
        </n-data-table>
      </n-space>
    </n-card>

  <n-drawer v-model:show="showDrawer" :width="560">
    <n-drawer-content v-if="detailJob" :title="`任务详情 ${detailJob.id}`" closable>
      <n-space vertical :size="16">
        <n-space align="center">
          <n-tag :type="statusType(detailJob.status)">{{ detailJob.status }}</n-tag>
          <span>{{ detailJob.message }}</span>
        </n-space>
        <n-progress type="line" :percentage="progressOf(detailJob)" />
        <n-space v-if="detailJob.error">
          <n-tag type="error">错误</n-tag>
          <span>{{ detailJob.error }}</span>
        </n-space>

        <template v-if="detailJob.type === 'import'">
          <n-data-table
            :columns="[
              { title: '包名', key: 'name' },
              { title: '版本', key: 'version', width: 140 },
              {
                title: '状态',
                key: 'status',
                width: 110,
                render: (row) => h(NTag, { type: row.status === 'success' ? 'success' : row.status === 'failed' ? 'error' : row.status === 'skipped' ? 'warning' : 'info', size: 'small' }, { default: () => row.status })
              }
            ]"
            :data="(detailJob as ImportJob).results"
            :bordered="false"
          />
        </template>

        <n-space v-if="detailJob.type === 'export' && (detailJob as ExportJob).downloadUrl" justify="end">
          <n-button type="primary" tag="a" :href="(detailJob as ExportJob).downloadUrl">下载导出 zip</n-button>
        </n-space>
      </n-space>
    </n-drawer-content>
  </n-drawer>
  </div>
</template>

<style scoped>
.jobs-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-title {
  margin: 0;
  font-size: 16px;
  color: #0f172a;
}
</style>

