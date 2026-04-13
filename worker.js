export default {
  async fetch(request, env, ctx) {
    return await handleRequest(request);
  },
};

async function handleRequest(request) {
  const url = new URL(request.url);
  const host = url.host; // 动态获取当前域名

  // 1. 首页
  if (url.pathname === "/") {
    return new Response("Docker Proxy is Running", { status: 200 });
  }

  // 2. 认证服务器代理 (Auth)
  if (url.pathname.startsWith("/auth/")) {
    return proxyRequest(request, "https://auth.docker.io/", "/auth/");
  }

  // 3. Docker Registry 代理
  // 兼容两种路径：
  // - 直接访问: /docker.io/v2/...
  // - Docker CLI 访问: /v2/docker.io/...
  let targetPath = url.pathname;
  let pathPrefix = "";

  if (targetPath.startsWith("/docker.io/")) {
    pathPrefix = "/docker.io/";
    // 将 /docker.io/v2/... 转换为 /v2/... 格式
    const remainingPath = targetPath.substring(pathPrefix.length);
    if (remainingPath.startsWith("v2/")) {
      targetPath = "/" + remainingPath;
    } else {
      targetPath = "/v2/" + remainingPath;
    }
  } else if (targetPath.startsWith("/v2/docker.io/")) {
    // 重点：修复 Docker CLI 路径匹配
    pathPrefix = "/v2/docker.io/";
    // 将路径重定向为标准的 /v2/ 格式发给 Docker 官方
    targetPath = "/v2/" + targetPath.substring(pathPrefix.length);
  }

  if (pathPrefix) {
    return proxyRequest(
      request,
      "https://registry-1.docker.io/",
      pathPrefix,
      targetPath,
    );
  }

  // 4. 标准 V2 探测响应 (让 Docker 知道这是一个 Registry)
  if (url.pathname === "/v2/" || url.pathname === "/v2") {
    return new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Docker-Distribution-Api-Version": "registry/2.0",
      },
    });
  }

  return new Response("Not Found", { status: 404 });
}

async function proxyRequest(
  request,
  targetHost,
  pathPrefix,
  customPath = null,
) {
  const url = new URL(request.url);
  const actualPath = customPath || url.pathname.substring(pathPrefix.length);
  const targetUrl = new URL(
    targetHost.replace(/\/$/, "") +
      "/" +
      actualPath.replace(/^\//, "") +
      url.search,
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Host", targetUrl.host);

  // 处理 Auth 路径直接转发
  if (pathPrefix === "/auth/") {
    const authRes = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: requestHeaders,
      body: request.body,
    });
    return new Response(authRes.body, authRes);
  }

  // 第一次尝试请求 Registry
  let targetResponse = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: requestHeaders,
    body: request.body,
    redirect: "follow",
  });

  // 如果需要认证
  if (targetResponse.status === 401) {
    const authHeader = targetResponse.headers.get("WWW-Authenticate");
    if (authHeader) {
      const authParams = parseAuthHeader(authHeader);
      const currentHost = new URL(request.url).host;

      if (authParams.realm) {
        // 直接使用 Docker 官方的 auth server 获取 Token，避免循环
        const tokenUrl =
          `${authParams.realm}?service=${authParams.service}&scope=${authParams.scope}`;

        // Worker 代为获取 Token（直接请求官方 auth server）
        const tokenRes = await fetch(tokenUrl, {
          headers: { "User-Agent": "docker/20.10.0 go/go1.13.15" },
        });

        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          const token = tokenData.token || tokenData.access_token;

          if (token) {
            // 携带新 Token 再次请求
            const retryHeaders = new Headers(requestHeaders);
            retryHeaders.set("Authorization", `Bearer ${token}`);
            const retryResponse = await fetch(targetUrl.toString(), {
              method: request.method,
              headers: retryHeaders,
              body: request.body,
            });
            return handleFinalResponse(
              retryResponse,
              targetHost,
              pathPrefix,
              currentHost,
            );
          }
        }
      }
    }
  }

  return handleFinalResponse(
    targetResponse,
    targetHost,
    pathPrefix,
    new URL(request.url).host,
  );
}

// 处理最终响应，修复 Location 和跨域
function handleFinalResponse(response, targetHost, pathPrefix, currentHost) {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set("Access-Control-Allow-Origin", "*");

  // 修复重定向地址
  let location = newResponse.headers.get("Location");
  if (location && location.includes(new URL(targetHost).host)) {
    location = location.replace(
      new URL(targetHost).host,
      currentHost + pathPrefix.replace(/\/$/, ""),
    );
    newResponse.headers.set("Location", location);
  }

  return newResponse;
}

// 修复后的 Header 解析函数：使用正则提取 key-value
function parseAuthHeader(header) {
  const params = {};
  // 匹配 key="value" 格式
  const regex = /([\w]+)="([^"]+)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2];
  }
  return params;
}
