// 配置信息
const TARGET_REGISTRY = "https://ghcr.io";
const CACHE_TTL = 3600; 

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

  let targetResponse = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: requestHeaders,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
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
      `realm="https://${new URL(request.url).host}/token"`
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

  // 针对下载层 (Blobs) 尝试缓存
  const isCacheable = (request.method === "GET" && targetResponse.status === 200 && url.pathname.includes("/blobs/"));
  
  if (isCacheable) {
    // 简单起见，这里演示直接返回，生产环境可结合 caches.default 使用
    return new Response(targetResponse.body, {
      status: targetResponse.status,
      headers: responseHeaders,
    });
  }

  return new Response(targetResponse.body, {
    status: targetResponse.status,
    headers: responseHeaders,
  });
}