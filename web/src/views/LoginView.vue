<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSpin,
  NTabPane,
  NTabs
} from 'naive-ui'
import { api } from '../api'
import { resetSessionCache } from '../session'
import type { AuthLoginMethod } from '../types'

const route = useRoute()
const router = useRouter()
const methods = ref<AuthLoginMethod[]>([])
const selectedMethod = ref<AuthLoginMethod>('password')
const username = ref('')
const password = ref('')
const verdaccioUrl = ref('')
const loading = ref(true)
const submitting = ref(false)
const error = ref('')

const showTabs = computed(() => methods.value.length > 1)
const title = computed(() =>
  selectedMethod.value === 'verdaccio' ? 'Verdaccio 用户登录' : '管理员登录'
)

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message
  return '登录失败，请稍后再试'
}

function safeRedirect(): string {
  const redirect = route.query.redirect
  if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')) {
    return redirect
  }
  return '/export'
}

async function submit(): Promise<void> {
  if (!selectedMethod.value || submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    if (selectedMethod.value === 'password') {
      await api.login({ method: 'password', password: password.value })
    } else {
      await api.login({
        method: 'verdaccio',
        username: username.value.trim(),
        password: password.value
      })
    }
    resetSessionCache()
    await router.replace(safeRedirect())
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  try {
    const state = await api.session()
    if (!state.enabled) {
      await router.replace('/export')
      return
    }
    methods.value = state.methods
    selectedMethod.value = state.methods.includes('password') ? 'password' : state.methods[0]
    verdaccioUrl.value = state.verdaccioUrl ?? ''
    if (methods.value.length === 0) {
      error.value = '未配置可用的登录方式'
    }
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="login-page">
    <div class="login-shell">
      <aside class="login-brand-panel">
        <img src="/favicon.svg" alt="npm-porter" class="brand-hero-logo" />
        <h1>npm-porter</h1>
        <p>npm 包离线搬运与发布工具</p>
      </aside>

      <main class="login-form-panel">
        <n-card class="login-card" :bordered="false">
          <h2 class="login-title">登录</h2>

          <n-spin :show="loading">
            <template v-if="!loading && methods.length">
              <n-tabs v-if="showTabs" v-model:value="selectedMethod" type="line" class="login-tabs">
                <n-tab-pane name="password">
                  <template #tab>管理员登录</template>
                </n-tab-pane>
                <n-tab-pane name="verdaccio">
                  <template #tab>Verdaccio 用户登录</template>
                </n-tab-pane>
              </n-tabs>
              <div v-else class="login-mode">{{ title }}</div>

              <n-alert v-if="error" type="error" :show-icon="true" class="login-error">
                {{ error }}
              </n-alert>

              <n-form @keyup.enter="submit">
                <n-form-item v-if="selectedMethod === 'verdaccio'" label="用户名">
                  <n-input
                    v-model:value="username"
                    size="large"
                    placeholder="请输入 Verdaccio 用户名"
                    :disabled="submitting"
                  />
                </n-form-item>

                <n-form-item :label="selectedMethod === 'password' ? '管理员密码' : '密码'">
                  <n-input
                    v-model:value="password"
                    size="large"
                    type="password"
                    show-password-on="click"
                    placeholder="请输入密码"
                    :disabled="submitting"
                  />
                </n-form-item>

                <n-button type="primary" size="large" block :loading="submitting" @click="submit">
                  登录
                </n-button>
              </n-form>

              <div v-if="selectedMethod === 'verdaccio' && verdaccioUrl" class="login-verdaccio">
                登录目标：{{ verdaccioUrl }}
              </div>
            </template>
          </n-spin>
        </n-card>
      </main>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(circle at 15% 20%, rgba(37, 99, 235, 0.14), transparent 32%),
    radial-gradient(circle at 85% 85%, rgba(59, 130, 246, 0.12), transparent 34%),
    #f6f8fb;
}

.login-shell {
  width: 880px;
  max-width: 100%;
  display: grid;
  grid-template-columns: 0.9fr 1.1fr;
  overflow: hidden;
  border-radius: 20px;
  background: #ffffff;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.14);
}

.login-brand-panel {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 48px;
  color: #ffffff;
  background: linear-gradient(150deg, #2563eb 0%, #1d4ed8 58%, #1e40af 100%);
}

.brand-hero-logo {
  width: 76px;
  height: 76px;
  margin-bottom: 24px;
  filter: drop-shadow(0 12px 24px rgba(15, 23, 42, 0.22));
}

.login-brand-panel h1 {
  margin: 0;
  font-size: 32px;
  letter-spacing: -0.8px;
}

.login-brand-panel p {
  margin: 12px 0 0;
  color: #dbeafe;
  font-size: 15px;
  line-height: 1.6;
}

.login-form-panel {
  display: flex;
  align-items: center;
  padding: 40px;
}

.login-card {
  width: 100%;
  border-radius: 0;
  box-shadow: none;
}

.login-title {
  margin: 0 0 20px;
  font-size: 22px;
  letter-spacing: -0.4px;
  color: #0f172a;
}

.login-mode {
  margin-bottom: 16px;
  font-size: 16px;
  font-weight: 600;
  color: #1e293b;
}

.login-tabs {
  margin-bottom: 8px;
}

.login-error {
  margin-bottom: 16px;
}

.login-verdaccio {
  margin-top: 16px;
  font-size: 13px;
  color: #64748b;
  text-align: center;
  word-break: break-all;
}

@media (max-width: 768px) {
  .login-shell {
    grid-template-columns: 1fr;
  }

  .login-brand-panel {
    display: none;
  }

  .login-form-panel {
    padding: 28px 22px;
  }
}
</style>
