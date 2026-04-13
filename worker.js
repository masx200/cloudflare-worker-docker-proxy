export default {
  async fetch(request, env, ctx) {
    return await handleRequest(request);
  },
};

async function handleRequest(request) {
  const url = new URL(request.url);

  // 首页
  if (url.pathname === "/") {
    return new Response("Hello World!");
  }

  // Docker.io registry 代理 (registry-1.docker.io)
  if (url.pathname.startsWith("/docker.io/")) {
    return proxyRequest(
      request,
      "https://registry-1.docker.io/",
      "/docker.io/",
    );
  }

  // Auth.docker.io 代理（token 认证）
  if (url.pathname.startsWith("/auth/")) {
    return proxyRequest(request, "https://auth.docker.io/", "/auth/");
  }

  return new Response("Not Found", { status: 404 });
}

async function proxyRequest(request, targetHost, pathPrefix) {
  const url = new URL(request.url);
  const targetUrl = new URL(
    targetHost + url.pathname.substring(pathPrefix.length) + url.search,
  );

  // 对于auth路径，直接代理（添加Authorization转发）
  if (pathPrefix === "/auth/") {
    const targetResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: {
        ...request.headers, // 转发client的Authorization (docker login)
        Host: new URL(targetHost).host,
      },
      body: request.body,
    });
    const response = new Response(targetResponse.body, targetResponse);
    response.headers.set("Access-Control-Allow-Origin", "*");
    copyHeaders(targetResponse.headers, response.headers, ["Content-Type"]);
    return response;
  }

  // 对于registry路径，先检查是否需要auth（manifest/blob）
  const targetResponse = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: {
      ...request.headers,
      Host: new URL(targetHost).host,
      "Docker-Distribution-Api-Version": "registry/2.0",
    },
    body: request.body,
  });

  if (targetResponse.status === 401) {
    const authHeader = targetResponse.headers.get("WWW-Authenticate");
    if (authHeader) {
      const authParams = parseAuthHeader(authHeader);
      if (authParams.realm && authParams.service && authParams.scope) {
        // 直接调用auth API获取token（匿名pull）
        const authRealm = authParams.realm.replace(
          "https://auth.docker.io",
          "https://dhlr51os0a.masx200.ddns-ip.net/auth",
        );
        const tokenUrl = `${authRealm}?service=${authParams.service}&scope=${authParams.scope}`;

        try {
          // Worker fetch token（Docker客户端看不到此步骤）
          const tokenResponse = await fetch(tokenUrl, {
            headers: {
              Host: new URL(targetHost).host,
              "User-Agent": "docker/20.10.0 go/go1.13.15", // 模拟Docker
            },
          });

          if (tokenResponse.ok) {
            const tokenData = await tokenResponse.json();
            const token = tokenData.token || tokenData.access_token;

            if (token) {
              // 重试target请求，带token
              const retryResponse = await fetch(targetUrl.toString(), {
                method: request.method,
                headers: {
                  ...request.headers,
                  Host: new URL(targetHost).host,
                  "Docker-Distribution-Api-Version": "registry/2.0",
                  Authorization: `Bearer ${token}`,
                },
                body: request.body,
                redirect: "follow",
              });

              const response = new Response(retryResponse.body, {
                status: retryResponse.status,
                statusText: retryResponse.statusText,
                headers: retryResponse.headers,
              });
              response.headers.set("Access-Control-Allow-Origin", "*");
              response.headers.delete("www-authenticate");
              return response;
            }
          }
        } catch (error) {
          console.error("Token fetch error:", error);
        }
      }
    }
    // fallback 401
    return targetResponse;
  }

  // 正常响应处理（同原代码）
  const response = new Response(targetResponse.body, targetResponse);
  response.headers.set("Access-Control-Allow-Origin", "*");
  copyHeaders(targetResponse.headers, response.headers, [
    "Content-Type",
    "Content-Length",
    "Docker-Content-Digest",
    "Docker-Distribution-Api-Version",
  ]);
  let location = response.headers.get("Location");
  if (location) {
    location = location.replace(
      targetHost,
      `https://dhlr51os0a.masx200.ddns-ip.net${pathPrefix}`,
    );
    response.headers.set("Location", location);
  }
  return response;
}

function parseAuthHeader(header) {
  const params = {};
  header.split(",").forEach((param) => {
    const [key, value] = param.split("=");
    params[key.trim()] = value ? value.replace(/"/g, "") : "";
  });
  return params;
}

function copyHeaders(sourceHeaders, targetHeaders, keys) {
  keys.forEach((key) => {
    const value = sourceHeaders.get(key);
    if (value) targetHeaders.set(key, value);
  });
}
