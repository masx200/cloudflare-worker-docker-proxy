# Agents.md - AI Coding Assistant Guidelines

This file provides context for AI coding assistants working on this project.

## Project Overview

**Cloudflare Worker Docker Proxy** — 两个独立的 Cloudflare Worker，分别代理 Docker Hub 和 GitHub Container Registry (GHCR)，解决国内网络环境下 Docker 镜像拉取困难的问题。

### Worker Files

| File | Purpose | Target Registry |
|------|---------|-----------------|
| `worker.js` | Docker Hub 代理 | `registry-1.docker.io` + `auth.docker.io` |
| `worker-ghcr-io.js` | GHCR 代理 | `ghcr.io` |

## Architecture

Both workers follow the same general pattern but differ in authentication handling:

### Docker Hub Proxy (`worker.js`)
- Proxies `/auth/*` → `auth.docker.io` (token endpoint)
- Proxies `/docker.io/v2/*` and `/v2/docker.io/*` → `registry-1.docker.io`
- **Worker-side token acquisition**: On 401, parses `WWW-Authenticate`, fetches token from Docker's auth server directly, retries with Bearer token
- Uses `redirect: "follow"` (no Location rewriting needed)
- Has `addCorsHeaders()` and `handleFinalResponse()` helpers

### GHCR Proxy (`worker-ghcr-io.js`)
- Proxies `/token` and `/v2/token` → `ghcr.io/token`
- Proxies `/v2/*` → `ghcr.io`
- **Client-side authentication**: Passes through user's Basic Auth / Bearer token to upstream; rewrites `WWW-Authenticate` realm to point back to proxy
- Uses `redirect: "manual"` to intercept and rewrite 307 redirects
- **Blob redirect proxying**: GHCR redirects blob downloads to `pkg-containers.githubusercontent.com` (and similar CDN hosts). The worker rewrites Location to `/__proxy_upstream/<host>/<path>` and proxies the actual download through the worker itself (critical for CN network)
- `PROXY_DOMAINS` list defines which external domains get proxied

## Key Technical Details

### Caching
- Both workers use Cloudflare's `caches.default` API
- **Cache key**: always uses `GET` method (so HEAD can hit GET cache)
- **Cache write**: only on `GET` with status 200 (never cache HEAD responses — they have empty body and would poison cache)
- **Cache TTL**: 1 hour (`CACHE_TTL = 3600`)
- **HEAD request handling**: `new Response(null, { headers })` with explicit null body to preserve `Content-Length` and `Docker-Content-Digest` headers (Cloudflare Cache API can drop these otherwise)

### Docker Protocol Nuances
- Docker client uses HEAD requests to check blob existence and validate Content-Length / Docker-Content-Digest before downloading
- A missing or zero Content-Length causes `content size of zero: invalid argument` error
- 307 redirects for blob downloads are standard OCI/Distribution spec behavior

## Common Pitfalls (For AI Assistants)

1. **Never use `new Response(response.body, response)`** — the second argument's implicit header filtering can drop `Content-Length` on cached HEAD responses. Always use `new Headers(response.headers)` explicitly.
2. **Don't cache HEAD responses** — HEAD has no body; writing it to cache means subsequent GETs get empty body.
3. **GHCR blob redirects go to external domains** — just rewriting `ghcr.io` → proxy host is not enough; need the `/__proxy_upstream/` passthrough mechanism.
4. **`redirect: "manual"` vs `"follow"`** — GHCR proxy uses manual to intercept Location; Docker Hub proxy uses follow (it handles auth differently).
5. **The two workers are independent** — they are deployed as separate Cloudflare Workers with different domain bindings. Changes to one do not affect the other.

## Development Conventions

- Pure JavaScript (no TypeScript, no build step)
- ES module syntax (`export default { fetch() }`)
- No external dependencies
- Comments in Chinese where explaining business logic
- Git hosts: GitLab (primary) + GitHub (mirror)

## Testing

No automated test suite. Testing is done by deploying to Cloudflare Workers and running:

```bash
# Docker Hub proxy
docker pull <proxy-domain>/library/nginx:latest

# GHCR proxy
docker pull <proxy-domain>/home-assistant/home-assistant:latest
```
