# npm-porter

npm 包离线搬运与发布工具。外网直连 npm 上游完成搜索、依赖解析和 zip 导出；内网作为 Verdaccio 的上层工具，上传 zip 后按依赖顺序发布到 Verdaccio。

## 技术栈

- 后端：Node 20+、TypeScript、Fastify 5
- 前端：Vue 3、Vite、TypeScript、Naive UI
- 包管理：npm workspaces

## 目录结构

```
npm-porter/
├── server/   # Fastify 后端
├── web/      # Vue 3 + Naive UI 前端
└── server/data/ # 运行时数据（默认生成，已忽略提交）
```

## 本地开发

```bash
# 安装依赖
npm install

# 同时启动后端(3000)和前端(5173)
npm run dev

# 单独启动后端
npm run dev -w server

# 单独启动前端
npm run dev -w web
```

前端通过 Vite 将 `/api` 代理到 `http://localhost:3000`。

## 部署

支持两种部署方式，推荐使用 Docker Compose：

### 方式一：Docker Compose

镜像构建阶段已经包含 `npm ci` 和 `npm run build`，所以**宿主机不需要先构建**。`--build` 只是“重建镜像”，不是“在宿主机编译”。

#### 外网部署（可联网构建镜像）

首次部署或代码变更后需要重建镜像：

```bash
# 准备 compose 环境变量（会生成项目根目录 .env，已被 Git 忽略）
cp deploy/docker.env.example .env
# 按需修改 .env，尤其是 AUTH_PASSWORD、AUTH_SESSION_SECRET

# 构建并启动后端 + 前端 nginx
docker compose up -d --build
```

代码没变时，不需要重新构建，直接启动即可：

```bash
docker compose up -d
```

可选：同时启动内置 Verdaccio（端口默认 4873）：

```bash
docker compose --profile verdaccio up -d --build
```

启动后访问 `http://localhost:8080`。查看日志与停止：

```bash
docker compose logs -f server
docker compose down
```

#### 内网部署（离线导入镜像）

内网无法访问 Docker Hub / npm 时，**不要在内网执行 `--build`**。在外网机器完成构建和导出：

```bash
docker compose build
docker save npm-porter-server:latest npm-porter-web:latest | gzip > npm-porter-images.tar.gz

# 如果需要内置 Verdaccio，也一并导出
docker pull verdaccio/verdaccio:6
docker save verdaccio/verdaccio:6 | gzip > verdaccio-image.tar.gz
```

把导出的 `.tar.gz` 复制到内网机器后加载并启动，全程无需联网构建：

```bash
docker load -i npm-porter-images.tar.gz
docker load -i verdaccio-image.tar.gz  # 可选，使用内置 Verdaccio 时才需要

# 不使用内置 Verdaccio：
docker compose up -d --no-build

# 使用内置 Verdaccio：
docker compose --profile verdaccio up -d --no-build
```

如需对接已有的 Verdaccio，请在根目录 `.env` 中把 `AUTH_VERDACCIO_URL` 改为实际地址，无需启动 `verdaccio` profile。

### 方式二：Node 直接运行

适用于已有 Node 与 Nginx 环境的主机。

```bash
# 安装依赖并构建
npm ci
npm run typecheck
npm run build

# 准备后端配置
cp server/.env.example server/.env
# 按需修改 server/.env
```

后端常驻运行二选一：

#### PM2（跨平台，快速上手）

```bash
npm install -g pm2
pm2 start server/dist/index.js --name npm-porter-server
pm2 save
pm2 startup
```

查看日志：

```bash
pm2 logs npm-porter-server
```

#### systemd（Linux 生产推荐）

创建 `/etc/systemd/system/npm-porter.service`：

```ini
[Unit]
Description=npm-porter server
After=network.target

[Service]
WorkingDirectory=/opt/npm-porter
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now npm-porter
sudo systemctl status npm-porter
```

前端静态文件已生成在 `web/dist`，需要由 Nginx 托管并把 `/api` 转发到 `http://127.0.0.1:3000`：

```nginx
server {
    listen 80;
    server_name your-domain;

    client_max_body_size 512m;
    root /opt/npm-porter/web/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 后端监听端口 |
| `DATA_DIR` | `server/data/` | 运行时数据目录 |
| `DEFAULT_UPSTREAM_REGISTRY` | `https://registry.npmjs.org` | 默认上游 npm registry |
| `MAX_UPLOAD_MB` | `512` | zip 上传大小上限 |
| `AUTH_ENABLED` | `false` | 是否开启登录保护 |
| `AUTH_PASSWORD` | 无 | `password` 模式的管理员密码 |
| `AUTH_VERDACCIO_URL` | 私服列表第一条 | `verdaccio` 模式用于校验账密的 Verdaccio 地址 |
| `AUTH_SESSION_SECRET` | 每次启动随机生成 | Cookie 签名密钥；缺省时重启会使会话失效 |
| `AUTH_COOKIE_SECURE` | `false` | 是否给会话 Cookie 加 `Secure`，HTTPS 部署建议设为 `true` |

## 环境变量文件

- 后端启动时会自动读取 `server/.env`。
- 已存在的系统环境变量优先级最高。
- 可直接复制 `server/.env.example` 为 `server/.env` 后按需修改；`server/.env` 已被 Git 忽略。

## 登录配置

- 默认 `AUTH_ENABLED=false`，不启用登录，所有页面和 API 保持开放。
- 开启登录后，登录页会展示当前已配置的登录方式；`AUTH_PASSWORD` 对应“管理员登录”，`AUTH_VERDACCIO_URL` 对应“Verdaccio 用户登录”，两者都配置时由用户自行切换。
- Verdaccio 登录仅用于解锁 npm-porter，发布任务仍按任务单独填写发布凭据。
