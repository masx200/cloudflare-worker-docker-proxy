export default {
  async fetch(request, env, ctx) {
    return await handleRequest(request)
  }
};




async function handleRequest(request) {
  const url = new URL(request.url);

  // 首页
  if (url.pathname === '/') {
    return new Response('Hello World!');
  }

  // Docker.io registry 代理 (registry-1.docker.io)
  if (url.pathname.startsWith('/docker.io/')) {
    return proxyRequest(request, 'https://registry-1.docker.io/', '/docker.io/');
  }

  // Auth.docker.io 代理（token 认证）
  if (url.pathname.startsWith('/auth/')) {
    return proxyRequest(request, 'https://auth.docker.io/', '/auth/');
  }

  return new Response('Not Found', { status: 404 });
}

async function proxyRequest(request, targetHost, pathPrefix) {
  const url = new URL(request.url);
  const targetUrl = new URL(targetHost + url.pathname.substring(pathPrefix.length) + url.search);

  // Docker Registry V2 认证处理：如果 registry 返回 401，重定向到 auth
  const targetResponse = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: {
      ...request.headers,
      'Host': new URL(targetHost).host,
      // Docker API 版本头
      'Docker-Distribution-Api-Version': 'registry/2.0',
    },
    body: request.body,
  });

  // 处理 401：解析 WWW-Authenticate，返回 auth 重定向
  if (targetResponse.status === 401) {
    const authHeader = targetResponse.headers.get('WWW-Authenticate');
    if (authHeader) {
      const authParams = parseAuthHeader(authHeader);
      if (authParams.realm && authParams.service) {
        // 构建 auth URL，使用代理的 /auth/ 路径
        const authRealm = authParams.realm.replace('https://auth.docker.io', 'https://dhlr51os0a.masx200.ddns-ip.net/auth');
        const authUrl = `${authRealm}?service=${authParams.service}&scope=${authParams.scope || ''}`;
        return Response.redirect(authUrl, 302);
      }
    }
  }

  // 其他响应：复制头、body、状态
  const response = new Response(targetResponse.body, targetResponse);
  response.headers.set('Access-Control-Allow-Origin', '*');

  // 复制关键头，但修正 Location 等为代理路径
  copyHeaders(targetResponse.headers, response.headers, [
    'Content-Type', 'Content-Length', 'Docker-Content-Digest', 'Docker-Distribution-Api-Version'
  ]);

  // 修正 Location 头（如果有重定向）
  let location = response.headers.get('Location');
  if (location) {
    location = location.replace(targetHost, `https://dhlr51os0a.masx200.ddns-ip.net${pathPrefix}`);
    response.headers.set('Location', location);
  }

  return response;
}

function parseAuthHeader(header) {
  const params = {};
  header.split(',').forEach(param => {
    const [key, value] = param.split('=');
    params[key.trim()] = value ? value.replace(/"/g, '') : '';
  });
  return params;
}

function copyHeaders(sourceHeaders, targetHeaders, keys) {
  keys.forEach(key => {
    const value = sourceHeaders.get(key);
    if (value) targetHeaders.set(key, value);
  });
}