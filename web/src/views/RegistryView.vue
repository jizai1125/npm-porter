<script setup lang="ts">
import { h, onMounted, reactive, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import type { DataTableColumns, FormInst } from 'naive-ui'
import { api, ApiError } from '../api'
import type { RegistryConfig } from '../types'
import PageHeader from '../components/PageHeader.vue'

const message = useMessage()
const dialog = useDialog()
const registries = ref<RegistryConfig[]>([])
const loading = ref(false)
const showModal = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInst | null>(null)
const form = reactive<{ name: string; registry: string; authType: 'token' | 'basic' | 'none' }>({
  name: '',
  registry: '',
  authType: 'none'
})

async function loadRegistries(): Promise<void> {
  loading.value = true
  try {
    registries.value = await api.listRegistries()
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载私服配置失败')
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.registry = 'http://127.0.0.1:4873'
  form.authType = 'none'
  showModal.value = true
}

function openEdit(row: RegistryConfig): void {
  editingId.value = row.id
  form.name = row.name
  form.registry = row.registry
  form.authType = row.authType
  showModal.value = true
}

async function saveRegistry(): Promise<void> {
  await formRef.value?.validate()
  if (!form.name.trim() || !form.registry.trim()) {
    message.warning('请填写名称和 registry 地址')
    return
  }
  try {
    if (editingId.value) {
      await api.updateRegistry(editingId.value, form)
    } else {
      await api.createRegistry(form)
    }
    message.success('已保存')
    showModal.value = false
    await loadRegistries()
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '保存失败')
  }
}

function deleteRegistry(row: RegistryConfig): void {
  dialog.warning({
    title: '删除私服',
    content: `确认删除「${row.name}」？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deleteRegistry(row.id)
        message.success('已删除')
        await loadRegistries()
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : '删除失败')
      }
    }
  })
}

async function testRegistry(row: RegistryConfig): Promise<void> {
  try {
    const result = await api.testRegistry(row.id)
    if (result.ok) message.success(result.message)
    else message.warning(result.message)
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '测试失败')
  }
}

onMounted(loadRegistries)

const columns: DataTableColumns<RegistryConfig> = [
  { title: '名称', key: 'name', minWidth: 160 },
  { title: 'Registry', key: 'registry', minWidth: 240 },
  {
    title: '认证方式',
    key: 'authType',
    width: 120,
    render: (row) => h(NTag, { size: 'small' }, { default: () => row.authType })
  },
  {
    title: '操作',
    key: 'actions',
    width: 240,
    render: (row) =>
      h(NSpace, { size: 8 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'small',
              secondary: true,
              onClick: () => testRegistry(row)
            },
            { default: () => '测试' }
          ),
          h(
            NButton,
            {
              size: 'small',
              secondary: true,
              onClick: () => openEdit(row)
            },
            { default: () => '编辑' }
          ),
          h(
            NPopconfirm,
            { onPositiveClick: () => deleteRegistry(row) },
            {
              trigger: () =>
                h(
                  NButton,
                  {
                    size: 'small',
                    type: 'error',
                    quaternary: true,
                  },
                  { default: () => '删除' }
                ),
              default: () => '确认删除该私服？'
            }
          )
        ]
      })
  }
]
</script>

<template>
  <div class="registry-page">
    <PageHeader title="私服管理" description="管理目标 Verdaccio 地址，发布凭据不会保存。">
      <template #extra>
        <n-button type="primary" @click="openCreate">
          新增私服
        </n-button>
      </template>
    </PageHeader>

    <n-card class="registry-card">
      <template #header>
        <h3 class="section-title">私服列表</h3>
      </template>

      <n-data-table :columns="columns" :data="registries" :loading="loading" :bordered="false">
        <template #empty>
          <n-empty description="暂无私服配置" />
        </template>
      </n-data-table>
    </n-card>

    <n-modal v-model:show="showModal" preset="card" :title="editingId ? '编辑私服' : '新增私服'" style="max-width: 520px">
      <n-form ref="formRef" :model="form" label-placement="top">
        <n-form-item label="名称" path="name" required>
          <n-input v-model:value="form.name" placeholder="例如：内网 Verdaccio" />
        </n-form-item>
        <n-form-item label="Registry 地址" path="registry" required>
          <n-input v-model:value="form.registry" placeholder="http://127.0.0.1:4873" />
        </n-form-item>
        <n-form-item label="认证方式" path="authType">
          <n-select
            v-model:value="form.authType"
            :options="[
              { label: '匿名', value: 'none' },
              { label: 'Token', value: 'token' },
              { label: '用户名 / 密码', value: 'basic' }
            ]"
          />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showModal = false">取消</n-button>
          <n-button type="primary" @click="saveRegistry">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.registry-page {
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
