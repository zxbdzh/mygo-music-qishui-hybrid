// 外部音源只替换“取直链”这一步，汽水官方授权仍是回落目标。
// 这个模块也会被打进 MyGO 沙箱产物，所以不依赖 Node 内置模块。
const TIMEOUT = 8000;
const USER_AGENT = 'lx-music-desktop/2.99.0';
const QUALITY = { standard: '128k', high: '320k', lossless: 'flac' };

export function mapQuality(quality) {
  // 未知档位按 high 请求，避免把宿主不认识的取值直接发给解析服务。
  return QUALITY[quality] || QUALITY.high;
}

export function resolveUrl(payload) {
  // 实测上游业务失败仍是 HTTP 200，因此必须同时检查 code 与 url。
  if (!payload || typeof payload !== 'object') throw new Error('external source: malformed body');
  if (payload.code !== 200) throw new Error('external source: business failure');
  if (typeof payload.url !== 'string' || !payload.url) throw new Error('external source: missing url');
  return payload.url;
}

// 解析服务可能降档，回填不能凭空沿用请求档位。优先级：
// 1. 响应声明的档位；2. 链接扩展名能判断的容器；3. 无扩展名的 CDN 直链只能信任本次请求成功的档位。
const ACTUAL = {
  flac: { type: 'flac', quality: 'lossless' },
  '320k': { type: 'm4a', quality: 'high' },
  '128k': { type: 'm4a', quality: 'standard' },
};

const REQUESTED = {
  lossless: ACTUAL.flac,
  high: ACTUAL['320k'],
  standard: ACTUAL['128k'],
};

// 真实 CDN（douyinstatic 等）常把后缀省掉，只有明确的后缀才算容器证据。
const CONTAINER = /\.(flac|m4a|mp4|aac|mp3)$/i;

function actualQuality(url, payload, requested) {
  const stated = typeof payload?.quality === 'string' ? payload.quality.toLowerCase() : '';
  if (ACTUAL[stated]) return ACTUAL[stated];
  let container = '';
  try { container = new URL(url).pathname.match(CONTAINER)?.[1]?.toLowerCase() || ''; } catch { /* 校验阶段已拒绝非法地址 */ }
  if (container === 'flac') return ACTUAL.flac;
  // 有损容器不可能装无损；请求无损却拿到 m4a/mp3 时按最低档回填。
  if (container) return requested === 'lossless' ? ACTUAL['128k'] : REQUESTED[requested] || ACTUAL['320k'];
  return REQUESTED[requested] || ACTUAL['320k'];
}

const PRIVATE_IPV4 = /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
// IPv6 在 URL 里总带方括号；拒绝 ::、::1、::ffff: 映射与 fc00::/7 本地地址。
const PRIVATE_IPV6 = /^(?:\[::1?\]$|\[::ffff:|\[f[cd][0-9a-f]{0,2}:)/i;

export function assertSafeURL(value) {
  // 宿主 Go 侧会原样 GET 这个地址，放行内网地址等于把 SSRF 送进用户本机。
  if (typeof value !== 'string' || !value || value.length > 16384) throw new Error('external source: unsafe url');
  let url;
  try { url = new URL(value); } catch { throw new Error('external source: unsafe url'); }
  if (url.protocol !== 'https:') throw new Error('external source: unsafe url');
  if (url.username || url.password) throw new Error('external source: unsafe url');
  // 去掉尾点，避免 localhost. 绕过按名字的检查。
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new Error('external source: unsafe url');
  if (PRIVATE_IPV4.test(host) || PRIVATE_IPV6.test(host)) throw new Error('external source: unsafe url');
  return value;
}

export async function resolveExternal({ endpoint, key, id, quality, request = fetch, timeout = TIMEOUT }) {
  const target = new URL(endpoint);
  target.searchParams.set('source', 'qs');
  target.searchParams.set('songId', id);
  target.searchParams.set('quality', mapQuality(quality));
  // 宿主有播放超时，这里的请求必须自己先收尾，不能拖住 stream()。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const reply = await request(target.href, {
      method: 'GET',
      headers: { 'X-API-Key': key, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!reply || reply.status !== 200) throw new Error('external source: http status');
    const payload = await reply.json();
    const url = assertSafeURL(resolveUrl(payload));
    return { url, ...actualQuality(url, payload, quality) };
  } finally {
    clearTimeout(timer);
  }
}
