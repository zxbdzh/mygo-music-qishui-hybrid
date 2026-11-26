import test from 'node:test'
import assert from 'node:assert/strict'
import { loadScript, resolveExternal } from '../helper/external-source.mjs'
import { sandbox, session } from './fixtures/plugin-sandbox.mjs'

const script = 'const API_URL="https://source.test/api"; const Q={"qs":["flac"]};'
const url = 'https://source.test/script'
const options = { apiUrl: 'https://source.test/api', id: '123', quality: 'lossless' }

// 已成功取链但媒体不可用时，也必须回到现有官方播放入口。
test('dead media falls back through the production stream entry', async () => {
  const box = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:1/audio', type: 'm4a', quality: 'high' } }]], session, {
    settings: { externalSourceEnabled: 'true', externalSourceScript: url },
    request: async target => {
      if (String(target) === url) return new Response(script)
      if (String(target).startsWith('https://source.test/api/')) return Response.json({ code: 200, url: 'https://cdn.test/dead.flac' })
      if (String(target).startsWith('https://cdn.test/')) return new Response('denied', { status: 403 })
    },
  })
  const result = await box.api.stream({ id: '123', quality: 'lossless' })
  assert.equal(box.spawned(), 1)
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:/)
  assert.equal(box.logs.at(-1).text, 'external source fallback: failure')
})

const backupScript = 'const API_URL="https://backup.test/api"; const Q={"qs":["flac"]};'
const postScript = 'const API_URL="https://backup.test/api"; const handle = async () => fetch(`${API_URL}/music/url`, { method: "POST", body: { musicId } }); const Q={"qs":["flac"]};'

// 主脚本不支持该平台时，同一个播放请求要自动试备用脚本。
test('backup script answers when the primary cannot', async () => {
  const calls = []
  const box = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:9/o', type: 'm4a', quality: 'high' } }]], session, {
    settings: { externalSourceEnabled: 'true', externalSourceScript: url, externalSourceBackupScript: 'https://backup.test/script' },
    request: async target => {
      const href = String(target)
      calls.push(href)
      if (href === url) return new Response('const API_URL="https://source.test/api"; const Q={"tx":["128k"]};')
      if (href === 'https://backup.test/script') return new Response(backupScript)
      if (href.startsWith('https://backup.test/api/')) return Response.json({ code: 200, url: 'https://cdn.test/backup.flac' })
      if (href.startsWith('https://cdn.test/')) return new Response(Uint8Array.from([102, 76, 97, 67, 0, 0, 0, 0]), { status: 206 })
    },
  })
  const result = await box.api.stream({ id: '123', quality: 'lossless' })
  assert.equal(result.type, 'flac')
  assert.equal(box.spawned(), 0)
  assert.equal(box.logs.at(-1).text, 'external source fallback: unsupported')
})

// 备用脚本按 LX 官方插件约定用 POST + musicId；GET 会 404。
test('post scripts are asked with a JSON body and musicId', async () => {
  const seen = []
  const box = await sandbox([], session, {
    settings: { externalSourceEnabled: 'true', externalSourceBackupScript: 'https://backup.test/script' },
    request: async (target, init) => {
      const href = String(target)
      if (href === 'https://backup.test/script') return new Response(postScript)
      if (href.startsWith('https://backup.test/api/')) {
        seen.push({ method: init.method, body: JSON.parse(init.body), key: init.headers['X-API-Key'] })
        return Response.json({ code: 200, url: 'https://cdn.test/backup.flac' })
      }
      if (href.startsWith('https://cdn.test/')) return new Response(Uint8Array.from([102, 76, 97, 67, 0, 0, 0, 0]), { status: 206 })
    },
  })
  assert.equal((await box.api.stream({ id: '123', quality: 'lossless' })).type, 'flac')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'POST')
  assert.deepEqual(seen[0].body, { source: 'qs', musicId: '123', quality: 'flac' })
})

// 主备都失败时仍然只回落一次官方，不重复请求。
test('both scripts failing falls back to official once', async () => {
  const box = await sandbox([[{ ok: true, result: { url: 'http://127.0.0.1:10/p', type: 'm4a', quality: 'high' } }]], session, {
    settings: { externalSourceEnabled: 'true', externalSourceScript: url, externalSourceBackupScript: 'https://backup.test/script' },
    request: async target => {
      if (String(target).startsWith('https://backup.test/') || String(target) === url) return new Response('', { status: 500 })
    },
  })
  const result = await box.api.stream({ id: '123', quality: 'high' })
  assert.equal(box.spawned(), 1)
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:/)
})

// 过期失败与没有时间戳的旧缓存都必须重拉，避免永久锁在回落路径。
test('script cache expires and recovers without changing its URL', async () => {
  const cache = new Map()
  let calls = 0
  const input = { url, storage: cache, md5: () => 'hash', request: async () => {
    calls++
    if (calls === 1) throw new Error('offline')
    return new Response(script)
  } }
  const failed = await loadScript(input)
  assert.equal(failed.ok, false)
  assert.ok(failed.expiresAt - Date.now() <= 60000)
  await loadScript(input)
  assert.equal(calls, 1)
  failed.expiresAt = 0
  const recovered = await loadScript(input)
  assert.equal(recovered.ok, true)
  assert.equal(calls, 2)
  cache.set('lx-script:hash', { v: 1, ok: false })
  assert.equal((await loadScript(input)).ok, true)
  assert.equal(calls, 3)
})

// 缓存设备故障不能把已成功解析的脚本变为播放失败。
test('script resolution survives unavailable storage', async () => {
  const result = await loadScript({ url, md5: () => 'hash', storage: {
    get() { throw new Error('read failed') }, set() { throw new Error('write failed') },
  }, request: async () => new Response(script) })
  assert.equal(result.ok, true)
})

// API 标签和 URL 后缀不能覆盖实际字节，错误页必须在交接前拒绝。
test('media bytes determine format and dead links are rejected', async () => {
  for (const [bytes, type, quality] of [
    [[102,76,97,67,0,0,0,0], 'flac', 'lossless'],
    [[73,68,51,0,0,0,0,0], 'mp3', 'high'],
    [[255,241,80,0,0,0,0,0], 'aac', 'high'],
  ]) {
    const result = await resolveExternal({ ...options, request: async (target, init) => {
      if (String(target).startsWith('https://source.test/')) return Response.json({ code: 200, url: 'https://cdn.test/wrong.flac', quality: 'flac' })
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.Range, 'bytes=0-8191')
      return new Response(Uint8Array.from(bytes), { status: 206 })
    } })
    assert.equal(result.type, type)
    assert.equal(result.quality, quality)
  }
  for (const status of [403, 200]) {
    await assert.rejects(resolveExternal({ ...options, request: async target =>
      String(target).startsWith('https://source.test/')
        ? Response.json({ code: 200, url: 'https://cdn.test/dead.flac' })
        : new Response('<html>unavailable</html>', { status })
    }))
  }
})
