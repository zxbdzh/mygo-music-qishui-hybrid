import test from 'node:test'
import assert from 'node:assert/strict'
import { sandbox, json, session } from './fixtures/plugin-sandbox.mjs'
import { assertSafeURL, mapQuality } from '../helper/external-source.mjs'

// 脚本与接口都用保留域名；真实域名只活在用户设置里。
const scriptUrl = 'https://audio-source.test/api/script/lx?key=test-key'
const endpoint = 'https://audio-source.test/api/music/url'
const settings = { externalSourceEnabled: 'true', externalSourceScript: scriptUrl }
const track = { id: '7088232505400100866', quality: 'lossless' }
const script = [
  'const API_URL = "https://audio-source.test/api";',
  'const API_KEY = "test-key";',
  'const MUSIC_QUALITY = {"qs":["128k","320k","flac"]};',
].join('\n')
const js = (body = script) => new Response(body, { headers: { 'content-type': 'application/javascript' } })
const isScript = url => String(url) === scriptUrl
const isMusic = url => String(url).startsWith(endpoint)
const audio = type => new Response(Uint8Array.from(type === 'flac'
  ? [102, 76, 97, 67, 0, 0, 0, 0]
  : [0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]), { status: 206 })

// 媒体响应也走夹具，避免成功取链测试意外访问真实 CDN。
const pluginSandbox = sandbox
async function audioSandbox(queues, saved, options) {
  const request = options?.request
  return pluginSandbox(queues, saved, { ...options, request: async (url, init) => {
    if (init?.headers?.Range) return audio(options?.mediaType || (String(url).endsWith('.m4a') ? 'm4a' : 'flac'))
    return request?.(url, init)
  } })
}

test('脚本解析成功后走音源，不启动 Go worker', async () => {
  const box = await audioSandbox([], session, {
    settings,
    request: async url => isScript(url) ? js() : isMusic(url) ? json({ code: 200, url: 'https://cdn.test/song.flac' }) : undefined,
  })
  const s = await box.api.stream(track)
  assert.equal(s.type, 'flac')
  assert.equal(s.quality, 'lossless')
  assert.equal(box.spawned(), 0)
})

test('脚本没有 qs 音源时回落官方', async () => {
  const box = await audioSandbox([[{ ok: true, result: { url: 'http://127.0.0.1:1/x', type: 'm4a', quality: 'high', size: 1 } }]], session, {
    settings,
    request: async url => isScript(url)
      ? js('const API_URL = "https://audio-source.test/api";\nconst MUSIC_QUALITY = {"tx":["128k"]};')
      : undefined,
  })
  await box.api.stream(track)
  assert.equal(box.spawned(), 1)
  assert.equal(box.logs.at(-1).text, 'external source fallback: unsupported')
})

test('同一脚本只拉取一次', async () => {
  let pulled = 0
  const box = await audioSandbox([], session, {
    settings,
    request: async url => {
      if (isScript(url)) { pulled++; return js() }
      if (isMusic(url)) return json({ code: 200, url: 'https://cdn.test/song.flac' })
      return undefined
    },
  })
  await box.api.stream(track)
  await box.api.stream(track)
  assert.equal(pulled, 1)
})

test('填成直连接口地址时不再兼容', async () => {
  const box = await audioSandbox([[{ ok: true, result: { url: 'http://127.0.0.1:2/y', type: 'm4a', quality: 'high', size: 2 } }]], session, {
    settings: { externalSourceEnabled: 'true', externalSourceScript: endpoint },
    request: async url => isMusic(url) ? json({ code: 200, url: 'https://cdn.test/song.flac' }) : undefined,
  })
  await box.api.stream(track)
  assert.equal(box.spawned(), 1)
  assert.equal(box.logs.at(-1).text, 'external source fallback: script')
})

test('脚本没有 API_KEY 时用脚本地址里的 key', async () => {
  const box = await audioSandbox([], session, {
    settings,
    request: async url => isScript(url)
      ? js('const API_URL = "https://audio-source.test/api";\nconst MUSIC_QUALITY = {"qs":["flac"]};')
      : isMusic(url) ? json({ code: 200, url: 'https://cdn.test/song.flac' }) : undefined,
  })
  await box.api.stream(track)
  const call = box.authCalls.find(c => isMusic(c.url))
  assert.equal(call.options.headers['X-API-Key'], 'test-key')
})

test('内网地址被拒绝并回落官方路径', async () => {
  const box = await audioSandbox([[{ ok: true, result: { url: 'http://127.0.0.1:3/z', type: 'flac', quality: 'lossless', size: 3 } }]], session, {
    settings,
    request: async url => isScript(url) ? js() : isMusic(url) ? json({ code: 200, url: 'http://127.0.0.1:3/z' }) : undefined,
  })
  const s = await box.api.stream(track)
  assert.equal(box.spawned(), 1)          // 走了官方 worker
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:/) // 官方桥地址
})

test('业务码失败仍是 HTTP 200 也要回落', async () => {
  const box = await audioSandbox([[{ ok: true, result: { url: 'http://127.0.0.1:4/w', type: 'm4a', quality: 'high', size: 4 } }]], session, {
    settings,
    // 故意带上 url：只要实现漏看业务码，就会直接采用这个地址。
    request: async url => isScript(url) ? js() : isMusic(url)
      ? json({ code: 500, url: 'https://cdn.test/private.flac', message: '上游业务失败' })
      : undefined,
  })
  await box.api.stream({ id: track.id, quality: 'high' })
  assert.equal(box.spawned(), 1)
})

test('开关关闭时不请求脚本与接口', async () => {
  const box = await audioSandbox([[{ ok: true, result: { url: 'http://127.0.0.1:5/a', type: 'm4a', quality: 'high', size: 5 } }]], session, {
    settings: { ...settings, externalSourceEnabled: 'false' },
  })
  await box.api.stream({ id: track.id, quality: 'high' })
  assert.ok(!box.authCalls.some(c => isScript(c.url) || isMusic(c.url)))
})

test('非汽水 track_id 不发给音源', async () => {
  const box = await audioSandbox([], session, {
    settings,
    request: async () => json({ code: 200, url: 'https://cdn.test/song.flac' }),
  })
  // 官方路径对这类 ID 同样报不可播放，行为与关闭音源时一致。
  await assert.rejects(box.api.stream({ id: 'qishui:1', quality: 'high' }), error => error.code === 'unavailable')
  assert.ok(!box.authCalls.some(c => isScript(c.url) || isMusic(c.url)))
})

test('请求 lossless 但只回 128k 时如实标 standard', async () => {
  const box = await audioSandbox([], session, {
    settings,
    request: async url => isScript(url) ? js() : isMusic(url) ? json({ code: 200, url: 'https://cdn.test/song.m4a' }) : undefined,
  })
  const s = await box.api.stream(track)
  assert.equal(s.quality, 'standard')
  assert.equal(s.type, 'm4a')
})

test('CDN 直链没有扩展名时按请求档位回填', async () => {
  // 真实音源返回的 douyinstatic 直链没有 .flac/.m4a 后缀。
  const url = 'https://sf6-cdn-tos.douyinstatic.com/obj/tos-cn-ve-2774/oQHnniDxQFFPYnCfkiEgopaADkNCfzW5PBf3A9'
  const box = await audioSandbox([], session, {
    settings,
    request: async u => isScript(u) ? js() : isMusic(u) ? json({ code: 200, url, type: 21, server: 3 }) : undefined,
  })
  const s = await box.api.stream(track)
  assert.equal(s.type, 'flac')
  assert.equal(s.quality, 'lossless')

  const high = await audioSandbox([], session, {
    settings, mediaType: 'm4a',
    request: async u => isScript(u) ? js() : isMusic(u) ? json({ code: 200, url, type: 21 }) : undefined,
  })
  const h = await high.api.stream({ id: track.id, quality: 'high' })
  assert.equal(h.type, 'm4a')
  assert.equal(h.quality, 'high')
})

test('回落保留登录态且日志不含密钥', async () => {
  const box = await audioSandbox([[{ ok: true, result: { url: 'http://127.0.0.1:6/b', type: 'm4a', quality: 'high', size: 6 } }]], session, {
    settings,
    request: async url => isScript(url) ? js() : isMusic(url)
      ? json({ code: 500, url: 'https://cdn.test/private.flac', message: '上游业务失败' })
      : undefined,
  })
  const before = JSON.stringify([...box.state])
  await box.api.stream({ id: track.id, quality: 'high' })
  // 缓存会新增一条，其余登录态数据必须原样保留。
  const after = [...box.state].filter(([key]) => !key.startsWith('lx-script:'))
  assert.equal(JSON.stringify(after), before)
  assert.equal(box.logs.length, 1)
  const line = box.logs[0].text
  for (const secret of ['test-key', scriptUrl, endpoint, 'songId', 'private.flac']) assert.ok(!line.includes(secret), `log leaked ${secret}`)
})

test('取地址接口超时后回落且日志只记原因', async () => {
  const box = await audioSandbox([[{ ok: true, result: { url: 'http://127.0.0.1:7/c', type: 'm4a', quality: 'high', size: 7 } }]], session, {
    settings,
    // 8 秒的接口超时在测试里立即触发；其余定时器保持真实行为。
    timer: (callback, ms) => ms === 8000 ? (queueMicrotask(callback), 0) : setTimeout(callback, ms),
    request: async (url, options) => {
      if (isScript(url)) return js()
      if (isMusic(url)) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      return undefined
    },
  })
  await box.api.stream({ id: track.id, quality: 'high' })
  assert.equal(box.spawned(), 1)
  assert.equal(box.logs[0].text, 'external source fallback: timeout')
})

test('拉取脚本超时后回落且日志只记原因', async () => {
  const box = await audioSandbox([[{ ok: true, result: { url: 'http://127.0.0.1:8/d', type: 'm4a', quality: 'high', size: 8 } }]], session, {
    settings,
    timer: (callback, ms) => ms === 5000 ? (queueMicrotask(callback), 0) : setTimeout(callback, ms),
    request: async (url, options) => isScript(url)
      ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      : undefined,
  })
  await box.api.stream({ id: track.id, quality: 'high' })
  assert.equal(box.spawned(), 1)
  assert.equal(box.logs[0].text, 'external source fallback: timeout')
})

test('请求带 source=qs、songId、API Key 与客户端 UA', async () => {
  const box = await audioSandbox([], session, {
    settings,
    request: async url => isScript(url) ? js() : isMusic(url) ? json({ code: 200, url: 'https://cdn.test/song.flac' }) : undefined,
  })
  await box.api.stream(track)
  const call = box.authCalls.find(c => isMusic(c.url))
  const parsed = new URL(call.url)
  assert.equal(parsed.searchParams.get('source'), 'qs')
  assert.equal(parsed.searchParams.get('songId'), track.id)
  assert.equal(parsed.searchParams.get('quality'), 'flac')
  assert.equal(call.options.method, 'GET')
  assert.equal(call.options.headers['X-API-Key'], 'test-key')
  assert.equal(call.options.headers['User-Agent'], 'lx-music-desktop/2.99.0')
})

test('宿主音质映射到解析接口档位', () => {
  assert.equal(mapQuality('standard'), '128k')
  assert.equal(mapQuality('high'), '320k')
  assert.equal(mapQuality('lossless'), 'flac')
  assert.equal(mapQuality('unknown'), '320k') // 未知档位按 high 处理
})

test('地址校验拒绝内网、凭据与超长直链', () => {
  for (const url of [
    'http://cdn.test/song.flac',                          // 只接受 HTTPS
    'https://user:pw@cdn.test/song.flac',                // 不接受凭据
    'https://localhost/song.flac',
    'https://localhost./song.flac',                       // 尾点不能绕过名字检查
    'https://10.0.0.1/song.flac',
    'https://127.0.0.1/song.flac',
    'https://169.254.1.1/song.flac',
    'https://172.16.0.1/song.flac',
    'https://172.31.255.255/song.flac',
    'https://192.168.1.1/song.flac',
    'https://0.0.0.0/song.flac',
    'https://[::1]/song.flac',
    'https://[fd00::1]/song.flac',
    'https://cdn.test/' + 'a'.repeat(16400),
  ]) assert.throws(() => assertSafeURL(url), /unsafe url/, url)
  // 公网地址与名字相近的域名不能被误伤。
  for (const url of ['https://cdn.test/song.flac', 'https://172.15.0.1/song.flac', 'https://fdic.gov/song.flac']) {
    assert.equal(assertSafeURL(url), url)
  }
})
