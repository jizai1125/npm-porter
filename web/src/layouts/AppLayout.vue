<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import {
  NAvatar,
  NButton,
  NIcon,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu
} from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import {
  CloudUploadOutline,
  DownloadOutline,
  MenuOutline,
  ServerOutline,
  TimeOutline
} from '@vicons/ionicons5'
import { api } from '../api'
import { resetSessionCache } from '../session'
import type { AuthSessionState } from '../types'

const route = useRoute()
const router = useRouter()
const collapsed = ref(window.innerWidth <= 768)
const healthOk = ref<boolean | null>(null)
const auth = ref<AuthSessionState | null>(null)

const renderIcon = (icon: Component) => () => h(NIcon, null, { default: () => h(icon) })

const menuOptions: MenuOption[] = [
  { label: '导出打包', key: '/export', icon: renderIcon(DownloadOutline) },
  { label: '导入发布', key: '/import', icon: renderIcon(CloudUploadOutline) },
  { label: '私服管理', key: '/registries', icon: renderIcon(ServerOutline) },
  { label: '任务记录', key: '/jobs', icon: renderIcon(TimeOutline) }
]

const activeKey = computed(() => route.path)
const displayName = computed(() => auth.value?.username ?? '当前用户')
const displayInitial = computed(() => (displayName.value || '用').slice(0, 1))

let healthTimer: ReturnType<typeof setInterval> | undefined

async function checkHealth(): Promise<void> {
  try {
    const response = await fetch('/api/health', { credentials: 'include' })
    healthOk.value = response.ok
  } catch {
    healthOk.value = false
  }
}

async function loadAuth(): Promise<void> {
  try {
    auth.value = await api.session()
  } catch {
    auth.value = null
  }
}

async function logout(): Promise<void> {
  try {
    await api.logout()
  } finally {
    resetSessionCache()
    await router.replace('/login')
  }
}

onMounted(() => {
  checkHealth()
  loadAuth()
  healthTimer = setInterval(checkHealth, 15000)
})

onUnmounted(() => {
  if (healthTimer) clearInterval(healthTimer)
})
</script>

<template>
  <n-layout has-sider style="min-height: 100vh">
    <n-layout-sider bordered collapse-mode="width" :collapsed-width="68" :width="236" v-model:collapsed="collapsed" class="app-sider">
      <div class="brand">
        <img src="/favicon.svg" alt="npm-porter" class="brand-logo" />
        <strong v-if="!collapsed" class="brand-name">npm-porter</strong>
      </div>
      <n-menu
        :value="activeKey"
        :options="menuOptions"
        :collapsed="collapsed"
        :collapsed-width="68"
        class="side-menu"
        @update:value="(key: string) => router.push(key)"
      />
      <div v-if="!collapsed" class="sider-footer">
        <span>npm-porter</span>
        <span>v0.1.0</span>
      </div>
    </n-layout-sider>

    <n-layout>
      <n-layout-header bordered class="layout-header">
        <div class="header-left">
          <n-button quaternary circle size="small" class="collapse-button" @click="collapsed = !collapsed">
            <template #icon>
              <n-icon><MenuOutline /></n-icon>
            </template>
          </n-button>
        </div>
        <div class="header-right">
          <template v-if="auth?.enabled && auth?.authenticated">
            <div class="user-chip">
              <n-avatar round :size="28" color="#2563eb">{{ displayInitial }}</n-avatar>
              <span>{{ displayName }}</span>
            </div>
            <n-button text size="small" class="logout-button" @click="logout">退出登录</n-button>
          </template>
          <div class="health-pill" :class="healthOk === true ? 'is-ok' : healthOk === false ? 'is-error' : 'is-loading'">
            <span class="health-dot"></span>
            <span>{{ healthOk === true ? '后端正常' : healthOk === false ? '后端不可用' : '检测中' }}</span>
          </div>
        </div>
      </n-layout-header>

      <n-layout-content :native-scrollbar="false" class="layout-content">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<style scoped>
.app-sider {
  display: flex;
  flex-direction: column;
}

.app-sider :deep(.n-layout-sider-scroll-container) {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.brand {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  flex: none;
}

.app-sider.n-layout-sider--collapsed .brand {
  padding: 0;
  justify-content: center;
}

.brand-logo {
  width: 26px;
  height: 26px;
  flex: none;
}

.brand-name {
  font-size: 15px;
}

.side-menu {
  flex: 1;
  padding: 8px;
}

.app-sider :deep(.n-menu--collapsed .n-menu-item-content) {
  padding-left: 0 !important;
  padding-right: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
}

.app-sider :deep(.n-menu--collapsed .n-menu-item-content__icon) {
  margin-right: 0 !important;
}

.app-sider :deep(.n-menu--collapsed .n-menu-item-content-header) {
  display: none;
}

.sider-footer {
  flex: none;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px;
  border-top: 1px solid var(--np-border);
  color: #94a3b8;
  font-size: 12px;
}

.layout-header {
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.collapse-button {
  display: inline-flex;
}

.health-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 12px;
}

.health-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #94a3b8;
}

.health-pill.is-ok .health-dot {
  background: #16a34a;
}

.health-pill.is-error .health-dot {
  background: #dc2626;
}

.health-pill.is-loading .health-dot {
  background: #f59e0b;
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #334155;
  font-size: 13px;
}

.logout-button {
  color: #64748b;
}

.layout-content {
  padding: 24px;
  min-height: calc(100vh - 64px);
}

@media (max-width: 768px) {
  .layout-header {
    padding: 0 16px;
  }

  .layout-content {
    padding: 16px;
  }
}
</style>
