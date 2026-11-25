import test from 'node:test'
import assert from 'node:assert/strict'
import { sandbox, json, session } from './fixtures/plugin-sandbox.mjs'
import { assertSafeURL, mapQuality } from '../helper/external-source.mjs'

// 解析服务用保留域名测试；真实域名只出现在 plugin.json 的网络权限里。
const endpoint = 'https://audio-source.test/api/music/url'
const settings = {
  externalSourceEnabled: 'true',
  externalSourceEndpoint: endpoint,
  externalSourceKey: 'test-key',
}
const track = { id: '7088232505400100866', quality: 'lossless' }

test('音源成功时不启动 Go worker', async () => {
  const box = await sandbox([], session, {
    settings,
    request: async url => String(url).startsWith(endpoint)
      ? json({ code: 200, url: 'https://cdn.test/song.flac' })
      : undefined,
  })
  const s = await box.api.stream(track)
  assert.equal(s.type, 'flac')
  assert.equal(s.quality, 'lossless')
  assert.equal(box.spawned(), 0)
})

test('内网地址被拒绝并回落官方路径', async () => {
  const box = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:1/x', type: 'flac', quality: 'lossless', size: 1 } }]], session, {
    settings,
    request: async url => String(url).startsWith(endpoint)
      ? json({ code: 200, url: 'http://127.0.0.1:1/x' })
      : undefined,
  })
  const s = await box.api.stream(track)
  assert.equal(box.spawned(), 1)          // 走了官方 worker
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:/) // 官方桥地址
})

test('业务码失败仍是 HTTP 200 也要回落', async () => {
  const box = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:2/y', type: 'm4a', quality: 'high', size: 2 } }]], session, {
    settings,
    // 故意带上 url：只要实现漏看业务码，就会直接采用这个地址。
    request: async url => String(url).startsWith(endpoint)
      ? json({ code: 500, url: 'https://cdn.test/private.flac', message: '上游业务失败' })
      : undefined,
  })
  await box.api.stream({ id: track.id, quality: 'high' })
  assert.equal(box.spawned(), 1)
})

test('开关关闭时不请求解析服务', async () => {
  const box = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:3/z', type: 'm4a', quality: 'high', size: 3 } }]], session, {
    settings: { ...settings, externalSourceEnabled: 'false' },
  })
  await box.api.stream({ id: track.id, quality: 'high' })
  assert.ok(!box.authCalls.some(c => String(c.url).startsWith(endpoint)))
})

test('非汽水 track_id 不发给解析服务', async () => {
  const box = await sandbox([], session, {
    settings,
    request: async () => json({ code: 200, url: 'https://cdn.test/song.flac' }),
  })
  // 官方路径对这类 ID 同样报不可播放，行为与关闭音源时一致。
  await assert.rejects(box.api.stream({ id: 'qishui:1', quality: 'high' }), error => error.code === 'unavailable')
  assert.ok(!box.authCalls.some(c => String(c.url).startsWith(endpoint)))
})

test('请求 lossless 但只回 128k 时如实标 standard', async () => {
  const box = await sandbox([], session, {
    settings,
    request: async url => String(url).startsWith(endpoint)
      ? json({ code: 200, url: 'https://cdn.test/song.m4a' })
      : undefined,
  })
  const s = await box.api.stream(track)
  assert.equal(s.quality, 'standard')
  assert.equal(s.type, 'm4a')
})

test('CDN 直链没有扩展名时按请求档位回填', async () => {
  // 真实解析服务返回的 douyinstatic 直链没有 .flac/.m4a 后缀。
  const url = 'https://sf6-cdn-tos.douyinstatic.com/obj/tos-cn-ve-2774/oQHnniDxQFFPYnCfkiEgopaADkNCfzW5PBf3A9'
  const box = await sandbox([], session, {
    settings,
    request: async () => json({ code: 200, url, type: 21, server: 3 }),
  })
  const s = await box.api.stream(track)
  assert.equal(s.type, 'flac')
  assert.equal(s.quality, 'lossless')

  const high = await sandbox([], session, {
    settings,
    request: async () => json({ code: 200, url, type: 21 }),
  })
  const h = await high.api.stream({ id: track.id, quality: 'high' })
  assert.equal(h.type, 'm4a')
  assert.equal(h.quality, 'high')
})

test('回落保留登录态且日志不含密钥', async () => {
  const box = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:4/w', type: 'm4a', quality: 'high', size: 4 } }]], session, {
    settings,
    request: async url => String(url).startsWith(endpoint)
      ? json({ code: 500, url: 'https://cdn.test/private.flac', message: '上游业务失败' })
      : undefined,
  })
  const before = JSON.stringify([...box.state])
  await box.api.stream({ id: track.id, quality: 'high' })
  assert.equal(JSON.stringify([...box.state]), before)
  assert.equal(box.logs.length, 1)
  const line = box.logs[0].text
  for (const secret of ['test-key', endpoint, 'songId', 'private.flac']) assert.ok(!line.includes(secret), `log leaked ${secret}`)
})

test('解析服务超时后回落且日志只记原因', async () => {
  const box = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:5/t', type: 'm4a', quality: 'high', size: 5 } }]], session, {
    settings,
    // 8 秒的主机超时在测试里立即触发；其余定时器保持真实行为。
    timer: (callback, ms) => ms === 8000 ? (queueMicrotask(callback), 0) : setTimeout(callback, ms),
    request: async (url, options) => String(url).startsWith(endpoint)
      ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      : undefined,
  })
  await box.api.stream({ id: track.id, quality: 'high' })
  assert.equal(box.spawned(), 1)
  assert.equal(box.logs[0].text, 'external source fallback: timeout')
})

test('请求带 source=qs、songId、API Key 与客户端 UA', async () => {
  const box = await sandbox([], session, {
    settings,
    request: async () => json({ code: 200, url: 'https://cdn.test/song.flac' }),
  })
  await box.api.stream(track)
  const call = box.authCalls.find(c => String(c.url).startsWith(endpoint))
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
