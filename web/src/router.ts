import { createRouter, createWebHistory } from 'vue-router'
import type { RouteLocationNormalized } from 'vue-router'
import { setUnauthorizedHandler } from './api'
import { loadSession, resetSessionCache } from './session'
import AppLayout from './layouts/AppLayout.vue'
import LoginView from './views/LoginView.vue'
import ExportView from './views/ExportView.vue'
import ImportView from './views/ImportView.vue'
import RegistryView from './views/RegistryView.vue'
import JobsView from './views/JobsView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { title: '登录' } },
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', redirect: '/export' },
        { path: 'export', component: ExportView, meta: { title: '导出打包' } },
        { path: 'import', component: ImportView, meta: { title: '导入发布' } },
        { path: 'registries', component: RegistryView, meta: { title: '私服管理' } },
        { path: 'jobs', component: JobsView, meta: { title: '任务记录' } }
      ]
    }
  ]
})

router.beforeEach(async (to: RouteLocationNormalized) => {
  const session = await loadSession()

  if (to.path === '/login') {
    if (!session.enabled || session.authenticated) return { path: '/export' }
    return true
  }

  if (session.enabled && !session.authenticated) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  return true
})

setUnauthorizedHandler(() => {
  resetSessionCache()
  const current = router.currentRoute.value
  if (current.path !== '/login') {
    void router.replace({ path: '/login', query: { redirect: current.fullPath } })
  }
})

export default router
