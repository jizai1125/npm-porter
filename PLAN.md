# npm-porter 实施计划（整理合并版）

## Summary
- 单体 Web 应用：外网完成搜索、依赖解析和 zip 导出；内网上传 zip 后按依赖顺序发布到 Verdaccio。
- 技术栈固定为 Node 20+、TypeScript、Fastify 5、Vue 3 + Vite + Naive UI，中文 UI；提供 Docker 与 Node 直接运行两种部署方式。
- 输入支持双入口：手动搜索选择包与版本，或上传 `package-lock.json` / `npm-shrinkwrap.json` / `package.json` 解析现有工程依赖。
- Verdaccio 仅作为 registry 层，通过标准 `npm publish` 发布，不直接写 storage。
- 访问控制由 `AUTH_ENABLED` 决定是否开启；开启后登录页根据已配置凭据同时展示“管理员登录”和“Verdaccio 用户登录”，由用户自行选择，登录后建立 HttpOnly Cookie 会话。
- 后端启动时自动读取 `server/.env`，系统环境变量优先；提供 `server/.env.example` 作为配置模板。
- 本计划作为唯一实施基线；历史 `.codex\plans` 中的旧草稿保留但不再作为依据。

## Implementation Changes
- 搜索与选择：上游默认 `https://registry.npmjs.org`，可切换 `https://registry.npmmirror.com`；支持多选、版本选择、目标平台组合选择，默认 Linux x64 与 Windows x64。
- 依赖解析：手动输入或 lockfile 输入统一生成精确包清单；使用临时 `package.json` + `npm install --package-lock-only --ignore-scripts --omit=dev --omit=peer --os/--cpu/--libc` 解析，多平台 lock 条目合并为并集。
- 依赖范围：递归导出 `dependencies + optionalDependencies`，保留 scoped 和平台可选包；排除纯 `dev`、`peer`、`link`、`workspace` 条目；lockfile 有 `resolved`/`integrity` 时优先使用。
- 可复现导出：生成稳定的 `manifest.json` + `package-lock.json` + `tarballs/<name>@<version>.tgz`；manifest 固定 `schemaVersion`、字段顺序和字典序包排序，scoped 包将 `/` 替换为 `__`。
- 下载校验：tarball 下载后立即按 lockfile 或 registry 的 SHA-1/integrity 校验，失败可重试；zip 内记录每个包的依赖关系和完整性。
- 导入发布：上传 zip 后先校验 manifest、tarball 完整性和路径穿越，再按依赖拓扑排序；使用临时 `.npmrc` 注入内存凭据，逐包执行 `npm publish <tgz> --registry <url> --userconfig <tmp> --ignore-scripts`，scoped 包附加 `--access public`。
- 失败处理：单包失败不中断，汇总失败项并支持重试；临时 `.npmrc` 权限设为 `0600`，用后即删，日志不回显 token。
- UI：导出页、导入发布页、任务进度页、私服配置页；所有进度、失败原因、重试和下载结果可直接查看。

## Interfaces
- `ExportRequest`：`{ source: 'manual' | 'lockfile', registry, targets: [{ os, cpu, libc? }], packages?: [{ name, version }], lockfile?: File }`。
- `ManifestV1`：`{ schemaVersion, exportedAt, sourceRegistry, targets, rootPackages, packages: [{ name, version, tarball, shasum, integrity, dependencies, optionalDependencies }] }`。
- `RegistryConfig`：`{ id, name, registry, scopes?, authType: 'token' | 'basic' }`，持久化到 `server/data/registries.json`，不含凭据。
- `PublishRequest`：`{ registryId, credentials: { token } | { username, password } }`，凭据仅存请求内存和临时 `.npmrc`。
- API：`GET /api/health`、`GET /api/search`、`GET /api/packument`、`POST /api/exports`、`GET /api/jobs/:id`、`GET /api/exports/:id/download`、`POST /api/imports`、`POST /api/imports/:id/retry`、`GET/POST/PUT/DELETE /api/registries`。

## Test Plan
- 测试环境：本地部署 Verdaccio 作为集成与验收目标，地址 `http://127.0.0.1:4873`，可临时启动 `npx verdaccio@latest --listen 4873`；测试数据使用独立临时 storage，避免污染项目 `server/data/`。
- 单元测试：lockfile 合并与过滤、zip 路径清洗、依赖拓扑排序、manifest 生成/解析与字段稳定性、临时 `.npmrc` 生成与清理。
- 平台测试：使用同时含 `@esbuild/linux-x64` 与 `@esbuild/win32-x64` 的 fixture，验证两个平台包都进入导出清单。
- 集成测试：本地 Verdaccio 中完成“手动选包导出”和“lockfile 导出”两条链路，上传发布后执行 `npm install --registry http://127.0.0.1:4873` 验证可安装。
- 安全测试：构造 `../` 恶意 zip 验证被拒绝；验证 token 不写入配置、不进入日志；验证上传大小限制。
- 登录测试：`off` 模式不回归；`password` 模式验证 401、登录、Cookie、登出；`verdaccio` 模式用本地 Verdaccio 验证正确/错误账密，且校验不新增用户。
- UI 冒烟：`npm run build` 成功，导出、导入、任务进度、私服配置页面基本交互可用。

## Assumptions
- 目标私服锁定 Verdaccio，通过 HTTP `npm publish` 发布；不直写 storage，不修改 Verdaccio 配置。
- 只导出生产依赖，排除 `dev`/`peer`；不支持 Git、本地 file、workspace 依赖。
- 默认关闭登录；开启登录时页面与 API 全部保护，登录方式由用户选择，Verdaccio 用户仅用于登录鉴权，发布凭据仍按任务填写；首版使用内存会话，服务重启后需重新登录。
- v1 不实现增量导出、zip 加密和断点续传；zip 依赖人工安全传输。
- 目标平台按用户选择的 OS/arch 解析 optional 包，不打包所有平台版本。
