// 配置信息
const TARGET_REGISTRY = "https://ghcr.io";
const CACHE_TTL = 3600; // 1小时缓存

export default {
  async fetch(request, env, ctx) {
    return await handleRequest(request);
  },
};

async function handleRequest(request) {
  const url = new URL(request.url);
  const currentHost = url.host;

  // 1. 首页测试
  if (url.pathname === "/") {
    return new Response("GHCR Proxy is Running", { status: 200 });
  }

  // 2. 处理认证 Token 请求 (docker login 或 pull 时的获取 token 阶段)
  // GHCR 的认证路径通常是 /token
  if (url.pathname === "/token" || url.pathname === "/v2/token") {
    return proxyRequest(request, TARGET_REGISTRY, "");
  }

  // 3. 处理标准 V2 API 请求
  if (url.pathname.startsWith("/v2/")) {
    return proxyRequest(request, TARGET_REGISTRY, "");
  }

  return new Response("Not Found", { status: 404 });
}

async function proxyRequest(request, targetHost, pathPrefix) {
  const url = new URL(request.url);
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
      return addCorsHeaders(cachedResponse);
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

  // 构造响应
  let responseHeaders = new Headers(targetResponse.headers);

  // --- 核心修复：重写 WWW-Authenticate 响应头 ---
  // 当 Registry 返回 401 时，它会告诉客户端去哪里拿 Token。
  // 我们需要把那个地址改成本 Proxy 的地址。
  const authHeader = responseHeaders.get("WWW-Authenticate");
  if (authHeader && targetResponse.status === 401) {
    const rewrittenAuth = authHeader.replace(
      /realm="https:\/\/ghcr.io\/token"/g,
      `realm="https://${new URL(request.url).host}/token"`,
    );
    responseHeaders.set("WWW-Authenticate", rewrittenAuth);
  }

  // --- 核心修复：重写 Location 响应头 (处理 302 重定向) ---
  let location = responseHeaders.get("Location");
  if (location) {
    const targetHostName = new URL(targetHost).host;
    if (location.includes(targetHostName)) {
      location = location.replace(targetHostName, new URL(request.url).host);
      responseHeaders.set("Location", location);
    }
  }

  // 添加跨域
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  // 缓存成功的响应(仅 GET/HEAD 且状态码为 200)
  // 关键修复：必须在创建最终响应之前处理缓存
  // 因为 Response body 是流，只能被读取一次，需要先克隆
  if (isCacheable && cacheKey && targetResponse.status === 200) {
    try {
      // 克隆响应用于缓存（clone() 会创建独立的 body 流）
      const cachedResponse = targetResponse.clone();

      // 创建可变的 headers 副本
      const cacheHeaders = new Headers(cachedResponse.headers);
      cacheHeaders.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
      cacheHeaders.delete("Set-Cookie");

      // 创建新的响应对象用于缓存
      const responseToCache = new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: cacheHeaders,
      });

      // 写入缓存
      await caches.default.put(cacheKey, responseToCache);
    } catch (cacheError) {
      // 缓存失败不影响主流程
      console.warn("Cache write failed:", cacheError);
    }
  }

  return new Response(targetResponse.body, {
    status: targetResponse.status,
    headers: responseHeaders,
  });
}

// 为缓存响应添加 CORS 头
function addCorsHeaders(response) {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set("Access-Control-Allow-Origin", "*");
  return newResponse;
}
