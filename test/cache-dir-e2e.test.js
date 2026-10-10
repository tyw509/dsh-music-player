import { describe, it, expect, vi } from 'vitest'
import {
  mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, readFileSync, rmSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { join, resolve } = path

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = { method, url, headers }
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}
function makeRes() {
  const res = {
    status: 200, headers: {}, body: null,
    writeHead(status, headers) { res.status = status; res.headers = { ...(headers || {}) } },
    end(data) { res.body = data === undefined ? null : data },
  }
  return res
}
function makeFs(rootDir) {
  const stat = (target) => {
    if (!existsSync(target)) return undefined
    const s = statSync(target)
    return { type: s.isDirectory() ? 'directory' : 'file', size: s.size }
  }
  return {
    async resolve(p) { return resolve(p) },
    async stat(target) { return stat(target) },
    processPath(target) { return resolve(target) },
    async listDir(dir) {
      if (!existsSync(dir)) return []
      return readdirSync(dir, { withFileTypes: true }).map((e) => {
        const target = join(dir, e.name)
        const s = statSync(target)
        return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', target, size: s.size }
      })
    },
    async readBytes(target, _offset, _size) { return readFileSync(target) },
  }
}
async function boot() {
  const mod = await import('../lib/index.js?cachee2e=' + Date.now())
  const home = mkdtempSync(join(tmpdir(), 'dsh-music-cache-e2e-'))
  const musicDir = join(home, 'Music')
  mkdirSync(musicDir, { recursive: true })
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  const fs = makeFs(home)
  const registered = []
  const tools = []
  const loader = {
    name: 'test-loader',
    ctx: {
      shell: { resolve: (o) => o, run: async () => ({ stdout: { text: home } }) },
      fs,
      webServer: { register: (row) => { registered.push(row) } },
      tools: { register: (tool) => { tools.push(tool) } },
      systemPrompt: { section: () => {} },
      effect: (fn) => { fn() },
    },
  }
  mod.apply(loader.ctx)
  const routes = registered.filter((r) => r.kind === 'prefix' && r.path === '/dsh-music')
  const handler = routes.length > 0 ? routes[0].handler : null
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
  return { handler, cleanup }
}

describe('cache-dir pref end-to-end (real host handler)', () => {
  it('POST cache-dir -> GET reads back -> manifest delivers -> POST applies immediately; empty falls back; oversize dropped', async () => {
    const { handler, cleanup } = await boot()
    expect(handler).toBeTruthy()
    try {
      // fresh manifest: 默认 E:\Music
      const res0 = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res0)
      expect(JSON.parse(res0.body).cacheDir).toBe('E:\\Music')

      // POST 设置带空白的路径 → trim 后存
      const res1 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: { 'dsh-music-cache-dir': '  D:\\MyCache  ' } }) }),
        res1,
      )
      const d1 = JSON.parse(res1.body)
      expect(d1.ok).toBe(true)
      expect(d1.prefs['dsh-music-cache-dir']).toBe('D:\\MyCache')

      // GET 回读
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/prefs' }), res2)
      expect(JSON.parse(res2.body).prefs['dsh-music-cache-dir']).toBe('D:\\MyCache')

      // manifest 立即下发新目录（POST 后 applyCacheDirPref 生效）
      const res3 = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res3)
      expect(JSON.parse(res3.body).cacheDir).toBe('D:\\MyCache')

      // 超长值被丢弃（保留上一个）
      const res4 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: { 'dsh-music-cache-dir': 'x'.repeat(5000) } }) }),
        res4,
      )
      const d4 = JSON.parse(res4.body)
      // 超长值被丢弃 → 快照里仍是上一次的合法值（不是 5000 长度的脏值）
      expect(d4.prefs['dsh-music-cache-dir']).toBe('D:\\MyCache')

      // 空串被 sanitize 忽略 → 保留旧值（API 层语义：无效更新不生效；客户端清空走 remove）
      const res5 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: { 'dsh-music-cache-dir': '' } }) }),
        res5,
      )
      expect(JSON.parse(res5.body).prefs['dsh-music-cache-dir']).toBe('D:\\MyCache')

      // remove 清除 → 回落默认并立即生效
      const res5b = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ remove: ['dsh-music-cache-dir'] }) }),
        res5b,
      )
      expect('dsh-music-cache-dir' in JSON.parse(res5b.body).prefs).toBe(false)
      const res6 = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res6)
      expect(JSON.parse(res6.body).cacheDir).toBe('E:\\Music')
    } finally { cleanup() }
  })
})
