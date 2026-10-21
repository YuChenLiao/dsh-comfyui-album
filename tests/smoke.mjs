/**
 * 本地自检：用真实 HTTP 请求验证宿主 API 的契约（不启动 DSH）。
 *
 * 覆盖：/items（含元数据摘要与筛选）、/meta、/workflow 下载头、/file 字节、
 * 路径越权 403、未知路由 404、非 GET 405。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfa-smoke-'))
const nested = path.join(root, 'out')
fs.mkdirSync(nested, { recursive: true })

// 1×1 透明 PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const imagePath = path.join(nested, 'comfyui-20260101-000000-abcd.png')
fs.writeFileSync(imagePath, png)
fs.writeFileSync(`${imagePath}.json`, JSON.stringify({
  plugin: 'dsh-comfyui-image',
  prompt: 'a lighthouse on a cliff, dusk',
  negativePrompt: 'blurry',
  seed: 42,
  width: 1,
  height: 1,
  steps: 20,
  cfgScale: 7,
  checkpoint: 'sd_xl_base_1.0.safetensors',
  samplerName: 'euler',
  scheduler: 'normal',
  mode: 'text2img',
  createdAt: '2026-01-01T00:00:00.000Z',
  workflow: { '3': { class_type: 'KSampler' } },
}, null, 2))

// 同目录下没有 sidecar 的图片：默认不出现，all=1 时出现
fs.writeFileSync(path.join(root, 'bare.png'), png)
// 越权目录
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cfa-outside-'))
const outsideImage = path.join(outside, 'secret.png')
fs.writeFileSync(outsideImage, png)

let route = null
const ctx = {
  get(name) {
    if (name === 'webServer') {
      return {
        register(candidate) {
          route = candidate
          return () => { route = null }
        },
      }
    }
    if (name === 'workingDirectory') return { defaultDirectory: root }
    return undefined
  },
  effect(callback) {
    callback()
    return () => {}
  },
}

// 宿主会把进程 cwd 也算作一个根目录。这里把 cwd 切到临时目录，
// 免得插件自己目录里的图片（例如 README 截图）污染计数断言。
const previousCwd = process.cwd()
process.chdir(root)

apply(ctx, { roots: [], maxDepth: 2, maxItems: 100, cacheMs: 0 })

assert.ok(route, 'webServer.register 应当被调用')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/comfyui-album/api')

const server = http.createServer(route.handler)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const get = async (pathname) => {
  const res = await fetch(origin + pathname)
  const type = res.headers.get('content-type') || ''
  const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, body }
}

try {
  const rootsRes = await get('/comfyui-album/api/roots')
  assert.equal(rootsRes.status, 200)
  assert.equal(rootsRes.body.roots[0].path, fs.realpathSync.native(root))

  const list = await get('/comfyui-album/api/items?limit=10')
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1, '默认只列带 sidecar 的图')
  const item = list.body.items[0]
  assert.equal(item.path, imagePath)
  assert.equal(item.hasMeta, true)
  assert.equal(item.prompt, 'a lighthouse on a cliff, dusk')
  assert.equal(item.seed, 42)
  assert.equal(item.workflow, true)

  const withBare = await get('/comfyui-album/api/items?limit=10&all=1')
  assert.equal(withBare.body.total, 2, 'all=1 时包含没有元数据的图')

  const filtered = await get('/comfyui-album/api/items?limit=10&q=lighthouse')
  assert.equal(filtered.body.total, 1)
  const miss = await get('/comfyui-album/api/items?limit=10&q=not-there')
  assert.equal(miss.body.total, 0)

  // 越界 offset 必须返回空批次（客户端据此停手，否则底部会无限重拉）
  const pastEnd = await get('/comfyui-album/api/items?limit=10&offset=999')
  assert.equal(pastEnd.body.total, 1)
  assert.deepEqual(pastEnd.body.items, [])

  const meta = await get('/comfyui-album/api/meta?path=' + encodeURIComponent(imagePath))
  assert.equal(meta.status, 200)
  assert.equal(meta.body.meta.seed, 42)

  const workflow = await get('/comfyui-album/api/workflow?path=' + encodeURIComponent(imagePath))
  assert.equal(workflow.status, 200)
  assert.match(workflow.headers.get('content-disposition') || '', /attachment; filename="comfyui-20260101-000000-abcd\.workflow\.json"/)
  assert.deepEqual(workflow.body, { '3': { class_type: 'KSampler' } })

  const file = await get('/comfyui-album/api/file?path=' + encodeURIComponent(imagePath))
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'image/png')
  assert.equal(file.body.length, png.length)

  // 缩略图：sharp 可用时是 webp，不可用时安静回退原图 —— 两种都算过。
  const thumb = await get('/comfyui-album/api/file?thumb=1&path=' + encodeURIComponent(imagePath))
  assert.equal(thumb.status, 200)
  assert.match(thumb.headers.get('content-type') || '', /^image\/(webp|png)$/)

  const forbidden = await get('/comfyui-album/api/file?path=' + encodeURIComponent(outsideImage))
  assert.equal(forbidden.status, 403)
  const traversal = await get('/comfyui-album/api/file?path=' + encodeURIComponent(path.join(root, '..', '..', 'etc', 'passwd')))
  assert.equal(traversal.status, 403)

  const missingRoute = await get('/comfyui-album/api/nope')
  assert.equal(missingRoute.status, 404)

  const post = await fetch(origin + '/comfyui-album/api/items', { method: 'POST' })
  assert.equal(post.status, 405)

  const noMeta = await get('/comfyui-album/api/meta?path=' + encodeURIComponent(path.join(root, 'bare.png')))
  assert.equal(noMeta.status, 404)

  // ── 删除 ──
  const delForbidden = await fetch(origin + '/comfyui-album/api/delete?path=' + encodeURIComponent(outsideImage), { method: 'POST' })
  assert.equal(delForbidden.status, 403)

  const delViaGet = await get('/comfyui-album/api/delete?path=' + encodeURIComponent(imagePath))
  assert.equal(delViaGet.status, 405)

  const textFile = path.join(root, 'note.txt')
  fs.writeFileSync(textFile, 'x')
  const delNotImage = await fetch(origin + '/comfyui-album/api/delete?path=' + encodeURIComponent(textFile), { method: 'POST' })
  assert.equal(delNotImage.status, 400)
  assert.equal(fs.existsSync(textFile), true, '非图片文件不该被删')

  const del = await fetch(origin + '/comfyui-album/api/delete?path=' + encodeURIComponent(imagePath), { method: 'POST' })
  assert.equal(del.status, 200)
  const delBody = await del.json()
  assert.deepEqual(delBody.removed.slice().sort(), [imagePath, `${imagePath}.json`].sort())
  assert.equal(fs.existsSync(imagePath), false, '图片应被删除')
  assert.equal(fs.existsSync(`${imagePath}.json`), false, 'sidecar 应一并删除')

  const listAfterDelete = await get('/comfyui-album/api/items?limit=10&refresh=1')
  assert.equal(listAfterDelete.body.total, 0, '删除后不该再列出')
  const bareStill = await get('/comfyui-album/api/items?limit=10&all=1')
  assert.equal(bareStill.body.total, 1, '没有 sidecar 的图片不受影响')

  const delAgain = await fetch(origin + '/comfyui-album/api/delete?path=' + encodeURIComponent(imagePath), { method: 'POST' })
  assert.equal(delAgain.status, 404)

  console.log('smoke: 全部通过（宿主 API + 越权/错误路径 + 删除 7 项断言）')
} finally {
  server.close()
  process.chdir(previousCwd)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
}
