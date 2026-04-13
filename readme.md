# Docker Proxy Worker

一个基于 Cloudflare Workers 的 Docker Registry / Auth 代理服务，用于转发 Docker
相关请求，并处理认证、重定向和路径兼容问题。

## 功能特性

- 代理 Docker Registry 请求到 `registry-1.docker.io`
- 代理 Docker Auth 请求到 `auth.docker.io`
- 支持 Docker CLI 常见访问路径
- 自动处理认证流程并获取 Token
- 修复部分重定向地址
- 支持跨域访问
- 首页健康检查返回 `Docker Proxy is Running`

## 路由说明

### 1. 首页

访问 `/` 时，返回：

```text
Docker Proxy is Running
```

### 2. Auth 代理

所有以 `/auth/` 开头的请求，会转发到：

```text
https://auth.docker.io/
```

### 3. Docker Registry 代理

支持以下两种路径：

- `/docker.io/v2/...`
- `/v2/docker.io/...`

最终会代理到 Docker 官方 Registry：

```text
https://registry-1.docker.io/
```

### 4. Registry 探测

访问 `/v2/` 或 `/v2` 时，返回标准 Docker Registry 探测响应，便于 Docker
客户端识别该服务。

## 工作原理

该 Worker 会：

1. 识别请求路径
2. 将 Auth 请求转发到 Docker 官方认证服务器
3. 将 Registry 请求转发到 Docker 官方镜像仓库
4. 遇到 `401 Unauthorized` 时，解析 `WWW-Authenticate` 响应头
5. 自动向官方 Auth Server 请求 Token
6. 使用 Token 重新请求目标资源
7. 修正部分 `Location` 重定向头，避免跳转错误

## 部署方式

### 方式一：Cloudflare Workers

1. 登录 Cloudflare 控制台
2. 新建一个 Worker
3. 将 `worker.js` 内容粘贴进去
4. 保存并部署

### 方式二：Wrangler

如果你使用 Wrangler 管理项目，可以将代码放到 Worker 入口文件中，然后执行：

```bash
wrangler deploy
```

## 使用示例

部署成功后，你可以直接访问：

```text
https://your-domain.workers.dev/
```

返回：

```text
Docker Proxy is Running
```

Docker 客户端也可以通过该代理访问镜像仓库相关接口。

## 代码结构

- `fetch()`：Worker 入口
- `handleRequest()`：主路由逻辑
- `proxyRequest()`：请求转发与认证处理
- `handleFinalResponse()`：响应修正与返回
- `parseAuthHeader()`：解析 `WWW-Authenticate` 头

## 注意事项

- 该项目依赖 Docker 官方认证与 Registry 服务
- 部分 Docker 请求可能受网络环境、Cloudflare 限制或 Docker 官方策略影响
- 如果你打算用于生产环境，建议额外添加访问控制和日志监控
- 当前实现更适合学习、测试或个人使用

## 许可证

MIT
