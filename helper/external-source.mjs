// 外部音源只替换“取直链”这一步，汽水官方授权仍是回落目标。
// 这个模块也会被打进 MyGO 沙箱产物，所以不依赖 Node 内置模块。
const SCRIPT_TIMEOUT = 5000;
const MUSIC_TIMEOUT = 8000;
const SCRIPT_LIMIT = 262144;
const USER_AGENT = 'lx-music-desktop/2.99.0';
const QUALITY = { standard: '128k', high: '320k', lossless: 'flac' };
export const SCRIPT_CACHE = 'lx-script:';

async function readBytes(reply, limit) {
  if (!reply.body) return new Uint8Array();
  const reader = reply.body.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, limit - length);
      bytes.set(chunk, length);
      length += chunk.length;
    }
    return bytes.subarray(0, length);
  } finally {
    // CDN 可能忽略 Range，主动停止读取，避免取链阶段下载整首歌。
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

export function mapQuality(quality) {
  // 未知档位按 high 请求，避免把宿主不认识的取值直接发给解析服务。
  return QUALITY[quality] || QUALITY.high;
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

// 只读脚本里的声明，绝不执行脚本：第三方代码一旦运行就能拿到 host 与登录态。
export function parseScript(text) {
  if (typeof text !== 'string' || !text || text.length > SCRIPT_LIMIT) return null;
  const apiUrl = /\bAPI_URL\s*=\s*["'`](https?:\/\/[^"'`\s]+)["'`]/.exec(text)?.[1];
  if (!apiUrl) return null;
  try { assertSafeURL(apiUrl); } catch { return null; }
  const key = /\bAPI_KEY\s*=\s*["'`]([^"'`\s]+)["'`]/.exec(text)?.[1] || '';
  // 平台名在对象与 JSON.parse 两种写法里都带引号，一个正则即可判定。
  const qs = /["']qs["']\s*:/.test(text);
  // 两种 LX 服务协议：POST + musicId（如 c.wwwweb.top）与 GET + songId。
  const protocol = /method:\s*["'`]POST["'`]/i.test(text) && /\bmusicId\b/.test(text) ? 'post' : 'get';
  return { apiUrl, key, qs, protocol };
}

function urlKey(url) {
  try { return new URL(url).searchParams.get('key') || ''; } catch { return ''; }
}

// 拉取脚本并抽取声明；成功与不支持都写入缓存，改地址（含换 key）即换缓存键。
export async function loadScript({ url, storage, md5, request = fetch, timeout = SCRIPT_TIMEOUT }) {
  const cacheKey = SCRIPT_CACHE + md5(url);
  let cached;
  try { cached = storage.get(cacheKey); } catch { /* 缓存不可用时仍允许正常取链。 */ }
  // 旧缓存没有有效期，必须重取；短暂断网不能永久禁用同一脚本。
  if (cached?.v === 1 && Number.isFinite(cached.expiresAt) && cached.expiresAt > Date.now()) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let entry;
  try {
    const reply = await request(url, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!reply || reply.status !== 200) throw new Error('external source: script status');
    const bytes = await readBytes(reply, SCRIPT_LIMIT + 1);
    const parsed = bytes.length > SCRIPT_LIMIT ? null : parseScript(new TextDecoder().decode(bytes));
    entry = parsed
      ? { v: 1, ok: true, qs: parsed.qs, apiUrl: parsed.apiUrl, key: parsed.key || urlKey(url), protocol: parsed.protocol, reason: '' }
      : { v: 1, ok: false, qs: false, apiUrl: '', key: '', protocol: 'get', reason: 'script' };
  } catch (error) {
    // 网络失败仅短暂缓存，服务恢复后下一次播放可以自动重试。
    entry = { v: 1, ok: false, qs: false, apiUrl: '', key: '', protocol: 'get', reason: error?.name === 'AbortError' ? 'timeout' : 'script', transient: true };
  } finally {
    clearTimeout(timer);
  }
  const ttl = entry.ok && entry.qs ? 24 * 60 * 60 * 1000 : entry.transient ? 60 * 1000 : 10 * 60 * 1000;
  entry.expiresAt = Date.now() + ttl;
  try { storage.set(cacheKey, entry); } catch { /* 缓存写入失败不应丢弃已解析的音源。 */ }
  return entry;
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

async function verifyAudio(url, request, signal) {
  const reply = await request(url, { headers: { Range: 'bytes=0-8191' }, redirect: 'error', signal });
  if (!reply || ![200, 206].includes(reply.status)) throw new Error('external source: media status');
  const bytes = await readBytes(reply, 12);
  if (bytes.length < 8) throw new Error('external source: media header');
  const tag = String.fromCharCode(...bytes.slice(0, 4));
  if (tag === 'fLaC') return 'flac';
  if (tag === 'OggS') return 'ogg';
  if (tag === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WAVE') return 'wav';
  if (String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') return 'm4a';
  // ADTS AAC 与 MP3 都有帧同步，必须先分开再返回给对应解码器。
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'aac';
  if (tag.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mp3';
  throw new Error('external source: unsupported media');
}

export async function resolveExternal({ apiUrl, key, id, quality, protocol = 'get', request = fetch, timeout = MUSIC_TIMEOUT }) {
  // 脚本声明的 API_URL 是基址，取地址端点固定在 /music/url；两种服务只是方法和字段不同。
  const target = new URL(apiUrl.replace(/\/+$/, '') + '/music/url');
  const headers = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' };
  if (key) headers['X-API-Key'] = key;
  let init = { method: 'GET', headers };
  if (protocol === 'post') {
    // 备用服务按 LX 官方插件约定：POST + musicId，GET 会 404。
    init = { method: 'POST', headers, body: JSON.stringify({ source: 'qs', musicId: id, quality: mapQuality(quality) }) };
  } else {
    target.searchParams.set('source', 'qs');
    target.searchParams.set('songId', id);
    target.searchParams.set('quality', mapQuality(quality));
  }
  // 宿主有播放超时，这里的请求必须自己先收尾，不能拖住 stream()。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const reply = await request(target.href, { ...init, signal: controller.signal });
    if (!reply || reply.status !== 200) throw new Error('external source: http status');
    const payload = await reply.json();
    const url = assertSafeURL(resolveUrl(payload));
    // 业务成功仍可能返回过期链接或错误页，交给播放器前先用字节确认容器。
    const type = await verifyAudio(url, request, controller.signal);
    const reported = actualQuality(url, payload, quality).quality;
    const actual = type === 'flac' || type === 'wav' ? 'lossless' : reported === 'lossless' ? 'high' : reported;
    return { url, type, quality: actual };
  } finally {
    clearTimeout(timer);
  }
}
