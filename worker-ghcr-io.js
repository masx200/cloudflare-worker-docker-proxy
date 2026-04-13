// 配置信息
const TARGET_REGISTRY = "https://ghcr.io";
const CACHE_TTL = 3600; // 1小时缓存

// 需要透传代理的外部域名（GHCR blob 下载会重定向到这些域名）
const PROXY_DOMAINS = [
  "pkg-containers.githubusercontent.com",
  "containers.githubusercontent.com",
  "productionresultssa.blob.core.windows.net",
  "codeload.github.com",
  "github.com",
  "objects.githubusercontent.com",
];

export default {
  async fetch(request) {
    return await handleRequest(request);
  },
};

async function handleRequest(request) {
  const url = new URL(request.url);

  // 1. 首页测试
  if (url.pathname === "/") {
    return new Response("GHCR Proxy is Running", { status: 200 });
  }

  // 2. 处理认证 Token 请求 (docker login 或 pull 时的获取 token 阶段)
  if (url.pathname === "/token") {
    return proxyRequest(request, TARGET_REGISTRY, "");
  }

  // 3. 处理标准 V2 API 请求
  if (url.pathname.startsWith("/v2/")) {
    return proxyRequest(request, TARGET_REGISTRY, "");
  }

  // 4. 处理透传代理的外部 blob 下载请求
  // URL 格式: /__proxy_upstream/<encoded upstream host>/<path>
  if (url.pathname.startsWith("/__proxy_upstream/")) {
    return proxyUpstreamBlob(request);
  }

  return new Response("Not Found", { status: 404 });
}

// 处理透传的 blob 下载
async function proxyUpstreamBlob(request) {
  const url = new URL(request.url);

  // 解析路径: /__proxy_upstream/<host>/<remaining path>
  const rest = url.pathname.substring("/__proxy_upstream/".length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex === -1) {
    return new Response("Invalid proxy path", { status: 400 });
  }

  const upstreamHost = rest.substring(0, slashIndex);

  // 安全检查：只允许 PROXY_DOMAINS 白名单中的域名
  if (!PROXY_DOMAINS.includes(upstreamHost)) {
    console.warn(`Blocked unauthorized upstream host: ${upstreamHost}`);
    return new Response("Unauthorized upstream host", { status: 403 });
  }

  const upstreamPath = rest.substring(slashIndex);
  const targetUrl = `https://${upstreamHost}${upstreamPath}${url.search}`;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Host", upstreamHost);
  // 删除可能干扰的上游代理头
  // requestHeaders.delete("CF-Connecting-IP");
  // requestHeaders.delete("CF-IPCountry");
  // requestHeaders.delete("CF-Ray");
  // requestHeaders.delete("CF-Visitor");
  // requestHeaders.delete("X-Forwarded-For");
  // requestHeaders.delete("X-Forwarded-Proto");
  // requestHeaders.delete("X-Real-IP");

  let upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers: requestHeaders,
    redirect: "follow",
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

async function proxyRequest(request, targetHost, pathPrefix) {
  const url = new URL(request.url);
  const currentHost = url.host;
  const actualPath = url.pathname;
  const targetUrl = new URL(targetHost + actualPath + url.search);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Host", targetUrl.host);

  // 关键：允许 docker login 的 Basic Auth 能够传递
  // 此时 requestHeaders 中已包含用户的用户名密码（Base64）

  // 判断是否可缓存(仅 GET/HEAD)
  const isCacheable = request.method === "GET" || request.method === "HEAD";

  // 生成缓存键(使用目标 URL)
  const cacheKey = isCacheable
    ? new Request(targetUrl.toString(), { method: "GET" })
    : null;

  // 尝试从缓存读取
  if (isCacheable && cacheKey) {
    const cachedResponse = await caches.default.match(cacheKey);
    if (cachedResponse) {
      // HEAD 请求命中缓存：传 null body，但保留所有 Headers（尤其是 Content-Length）
      const isHead = request.method === "HEAD";
      return addCorsHeaders(cachedResponse, isHead);
    }
  }

  let targetResponse = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: requestHeaders,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : request.body,
    redirect: "manual", // 手动处理重定向以修复 Location
  });

  // --- 核心修复：重写 WWW-Authenticate 响应头 ---
  // 当 Registry 返回 401 时，它会告诉客户端去哪里拿 Token。
  // 我们需要把那个地址改成本 Proxy 的地址。
  const authHeader = targetResponse.headers.get("WWW-Authenticate");
  const isHead = request.method === "HEAD";
  if (authHeader && targetResponse.status === 401) {
    const rewrittenAuth = authHeader.replace(
      /realm="https:\/\/ghcr.io\/token"/g,
      `realm="https://${currentHost}/token"`,
    );
    const responseHeaders = new Headers(targetResponse.headers);
    responseHeaders.set("WWW-Authenticate", rewrittenAuth);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(isHead ? null : targetResponse.body, {
      status: targetResponse.status,
      statusText: targetResponse.statusText,
      headers: responseHeaders,
    });
  }

  // --- 核心修复：重写 307 Location 为经过本代理的路径 ---
  // GHCR 的 blob 下载返回 307 重定向到 pkg-containers.githubusercontent.com
  // Docker 客户端直接访问该外部域名会被重置，需要通过 Worker 代理下载
  if ([301, 302, 303, 307, 308].includes(targetResponse.status)) {
    let location = targetResponse.headers.get("Location");
    if (location) {
      try {
        const locationUrl = new URL(location);
        // 检查是否是需要代理的外部域名
        if (PROXY_DOMAINS.includes(locationUrl.host)) {
          // 将外部 URL 改写为通过本代理的路径
          const proxyPath =
            `/__proxy_upstream/${locationUrl.host}${locationUrl.pathname}${locationUrl.search}`;
          const responseHeaders = new Headers(targetResponse.headers);
          responseHeaders.set("Location", `https://${currentHost}${proxyPath}`);
          responseHeaders.set("Access-Control-Allow-Origin", "*");
          return new Response(null, {
            status: targetResponse.status,
            statusText: targetResponse.statusText,
            headers: responseHeaders,
          });
        }
        // 普通 ghcr.io 域名重定向
        const targetHostName = new URL(targetHost).host;
        if (location.includes(targetHostName)) {
          location = location.replace(targetHostName, currentHost);
          const responseHeaders = new Headers(targetResponse.headers);
          responseHeaders.set("Location", location);
          responseHeaders.set("Access-Control-Allow-Origin", "*");
          return new Response(null, {
            status: targetResponse.status,
            statusText: targetResponse.statusText,
            headers: responseHeaders,
          });
        }
      } catch (e) {
        // location URL 解析失败，原样返回
        console.warn("Failed to parse redirect Location:", location, e);
      }
    }
  }

  // 构造响应
  let responseHeaders = new Headers(targetResponse.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  // 缓存成功的响应(仅 GET 且状态码为 200)
  // 注意：不缓存 HEAD 响应，因为 HEAD 没有 body，写入缓存会导致后续 GET 也拿到空数据
  if (request.method === "GET" && cacheKey && targetResponse.status === 200) {
    try {
      const cachedResponse = targetResponse.clone();
      const cacheHeaders = new Headers(cachedResponse.headers);
      cacheHeaders.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
      cacheHeaders.delete("Set-Cookie");
      const responseToCache = new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: cacheHeaders,
      });
      await caches.default.put(cacheKey, responseToCache);
    } catch (cacheError) {
      console.warn("Cache write failed:", cacheError);
    }
  }

  return new Response(isHead ? null : targetResponse.body, {
    status: targetResponse.status,
    statusText: targetResponse.statusText,
    headers: responseHeaders,
  });
}

// 为缓存响应添加 CORS 头，HEAD 请求时传 null body 以保留 Content-Length 等 Headers
function addCorsHeaders(response, isHead = false) {
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(isHead ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
