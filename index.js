/**
 * dsh-comfyui-album —— 宿主侧。
 *
 * 职责只有一件事：把磁盘上由 dsh-comfyui-image 生成的图片（图片 + `<图片>.json`
 * sidecar）以只读 HTTP API 暴露给浏览器相册页。没有写操作，没有工具，也没有
 * 对 ComfyUI 的网络请求。
 *
 * 路由统一挂在 `/comfyui-album/api` 前缀下，避免和 SPA fallback 抢路径。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { IMAGE_EXTS, collectImages, mimeOf, readFullSidecar, toListItem } from './lib/scan.js'

/** 插件名（同时是 loader entry 的默认 id）。 */
export const name = 'dsh-comfyui-album'

/** 需要的宿主服务：HTTP 路由载体。 */
export const inject = ['webServer']

/** 版本号，随 package.json 走。 */
export const VERSION = '0.1.0'

/** API 前缀。 */
const PREFIX = '/comfyui-album/api'

/** 扫描结果缓存时间：点一次刷新就能看到新图，又不至于每滚一屏就重扫。 */
const DEFAULT_CACHE_MS = 4000

/**
 * 归一化配置。
 * @param {unknown} input loader 传进来的 config。
 * @returns {{ maxDepth: number, maxItems: number, cacheMs: number, roots: string[], includeHidden: boolean }}
 */
function resolveSettings(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const int = (value, fallback, min, max) => {
    const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    maxDepth: int(raw.maxDepth, 3, 0, 8),
    maxItems: int(raw.maxItems, 4000, 50, 20000),
    cacheMs: int(raw.cacheMs, DEFAULT_CACHE_MS, 0, 60000),
    includeHidden: raw.includeHidden === true,
    roots: Array.isArray(raw.roots)
      ? raw.roots.filter(item => typeof item === 'string' && item.trim() !== '')
      : [],
  }
}

/** @returns {string} 用户主目录。 */
function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ''
}

/**
 * dsh-comfyui-image 配置里的 outputDir（若用户显式指定过输出目录）。
 * @returns {string | undefined} 输出目录绝对路径。
 */
function comfyOutputDir() {
  const file = path.join(homeDir(), '.dsh-comfyui-image', 'config.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const dir = parsed !== null && typeof parsed === 'object' ? parsed.outputDir : undefined
    return typeof dir === 'string' && dir.trim() !== '' ? dir : undefined
  } catch {
    return undefined
  }
}

/** 规范化路径：绝对、去尾分隔符、realpath 尽量解析。 */
function canonical(target) {
  const abs = path.resolve(target)
  try {
    return fs.realpathSync.native(abs)
  } catch {
    return abs
  }
}

/** 根目录集合缓存：一屏缩略图会打几十次请求，每次重算 realpath 没必要。 */
let rootsCache = { at: 0, key: '', value: [] }

/**
 * 本插件允许读取的根目录集合。
 *
 * 来源：显式配置 → 默认工作目录 → 全部 workspace → comfyui 的 outputDir → 进程 cwd。
 * 之所以不止一个：图片落在「生成时的项目根目录」，用户手上通常有好几个项目。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {{ roots: string[] }} settings 归一化配置。
 * @returns {Array<{ path: string, label: string, kind: string }>} 去重后的根目录。
 */
function rootsOf(ctx, settings) {
  const cacheKey = settings.roots.join('|')
  const now = Date.now()
  if (rootsCache.key === cacheKey && now - rootsCache.at < 2000) return rootsCache.value

  const candidates = []
  for (const item of settings.roots) candidates.push({ path: item, kind: 'custom' })
  try {
    const cwd = ctx.get('workingDirectory')
    const dir = cwd?.defaultDirectory
    if (typeof dir === 'string' && dir !== '') candidates.push({ path: dir, kind: 'workspace' })
  } catch { /* 服务未挂载：下面还有其它来源 */ }
  try {
    const registry = ctx.get('workspaceRegistry')
    const list = typeof registry?.list === 'function' ? registry.list() : []
    for (const workspace of list) {
      if (typeof workspace?.path === 'string') candidates.push({ path: workspace.path, kind: 'workspace' })
    }
  } catch { /* 注册表不可用时忽略 */ }
  const outputDir = comfyOutputDir()
  if (outputDir !== undefined) candidates.push({ path: outputDir, kind: 'output' })
  candidates.push({ path: process.cwd(), kind: 'cwd' })

  const seen = new Set()
  const roots = []
  for (const candidate of candidates) {
    const abs = canonical(candidate.path)
    const key = abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    let exists = false
    try {
      exists = fs.statSync(abs).isDirectory()
    } catch {
      exists = false
    }
    if (!exists) continue
    roots.push({ path: abs, label: path.basename(abs) || abs, kind: candidate.kind })
  }
  rootsCache = { at: now, key: cacheKey, value: roots }
  return roots
}

/**
 * 请求路径是否落在某个授权根目录内。
 * @param {string} target 请求的绝对路径。
 * @param {Array<{ path: string }>} roots 授权根目录。
 * @returns {boolean} 是否允许读取。
 */
function isAuthorized(target, roots) {
  if (typeof target !== 'string' || target.trim() === '') return false
  if (target.includes('\0')) return false
  const abs = canonical(target).toLowerCase()
  return roots.some((root) => {
    const base = root.path.toLowerCase()
    return abs === base || abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
  })
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} value 响应体。
 * @returns {void}
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 扫描缓存：键为 `${root}|${maxDepth}|${maxItems}|${includeHidden}`。 */
const scanCache = new Map()

/** 列表缩略图边长上限。相册一屏几十张，原图直出会有上百 MB。 */
const THUMB_EDGE = 360

/** sharp 只加载一次；不可用（未安装 / 平台不匹配）时永久回退原图。 */
let sharpPromise = null
/**
 * 解析 sharp。
 *
 * link 安装时插件的物理路径不在 profile 的 node_modules 下，裸 `import('sharp')`
 * 会直接解析失败；所以再按 profile / dsh 安装树兜底。全都拿不到就安静回退原图。
 * @returns {Promise<any | null>} sharp 模块，或 null。
 */
function tryImportSharp() {
  return import('sharp').then(mod => mod.default ?? mod).catch(async () => {
    const bases = []
    if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
      bases.push(process.env.DSH_PROFILE_DIR)
    }
    const home = homeDir()
    if (home !== '') bases.push(path.join(home, '.dsh', 'profiles'))
    bases.push(path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'))
    for (const base of bases) {
      try {
        const req = createRequire(path.join(base, 'package.json'))
        const resolved = req.resolve('sharp')
        const mod = await import(pathToFileURL(resolved).href)
        return mod.default ?? mod
      } catch { /* 换下一个候选根 */ }
    }
    return null
  })
}

function loadSharp() {
  if (sharpPromise === null) sharpPromise = tryImportSharp()
  return sharpPromise
}

/**
 * 生成（或复用）一张图片的缩略图。
 * @param {string} target 原图绝对路径。
 * @param {import('node:fs').Stats} stat 原图 stat（用于缓存键）。
 * @returns {Promise<string | undefined>} 缩略图路径；无法生成时 undefined。
 */
async function ensureThumb(target, stat) {
  const sharp = await loadSharp()
  if (sharp === null) return undefined
  const key = crypto.createHash('sha1')
    .update(`${target.toLowerCase()}|${stat.mtimeMs}|${stat.size}|${THUMB_EDGE}`)
    .digest('hex')
  const dir = path.join(os.tmpdir(), 'dsh-comfyui-album-thumbs')
  const file = path.join(dir, `${key}.webp`)
  try {
    if (fs.statSync(file).size > 0) return file
  } catch { /* 还没生成，往下走 */ }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await sharp(target, { animated: false, limitInputPixels: 268435456 })
      .rotate()
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(temp)
    fs.renameSync(temp, file)
    return file
  } catch {
    return undefined
  }
}

/**
 * 带缓存的根目录扫描。
 * @param {string} root 根目录。
 * @param {{ maxDepth: number, maxItems: number, includeHidden: boolean, cacheMs: number }} settings 配置。
 * @param {boolean} force 跳过缓存。
 * @returns {{ files: Array<object>, truncated: boolean }}
 */
function scanRoot(root, settings, force) {
  const key = `${root}|${settings.maxDepth}|${settings.maxItems}|${settings.includeHidden}`
  const now = Date.now()
  if (!force && settings.cacheMs > 0) {
    const hit = scanCache.get(key)
    if (hit !== undefined && now - hit.at < settings.cacheMs) return hit.value
  }
  const value = collectImages(root, settings)
  scanCache.set(key, { at: now, value })
  if (scanCache.size > 64) {
    const oldest = [...scanCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest !== undefined) scanCache.delete(oldest[0])
  }
  return value
}

/**
 * 构造请求处理器。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {ReturnType<typeof resolveSettings>} settings 归一化配置。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function createHandler(ctx, settings) {
  const handleRoots = (res) => {
    const roots = rootsOf(ctx, settings)
    sendJson(res, 200, { ok: true, roots: roots.map(root => ({ ...root, id: root.path })) })
  }

  const handleItems = (url, res) => {
    const roots = rootsOf(ctx, settings)
    if (roots.length === 0) {
      sendJson(res, 200, { ok: true, items: [], total: 0, truncated: false, roots: [] })
      return
    }
    const wanted = url.searchParams.get('root') ?? 'all'
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const includeBare = url.searchParams.get('all') === '1'
    const force = url.searchParams.get('refresh') === '1'
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '60', 10) || 60))

    const targets = wanted === 'all'
      ? roots
      : roots.filter(root => root.path === wanted)
    if (targets.length === 0) {
      sendJson(res, 400, { ok: false, error: 'unknown-root', message: '这个根目录不在相册的白名单里。' })
      return
    }

    let truncated = false
    const merged = []
    for (const root of targets) {
      const scanned = scanRoot(root.path, settings, force)
      // 只有「影响本次结果」的截断才算数：默认只看生成图，普通图片被截断不该报提示。
      truncated = truncated || (includeBare ? scanned.truncated : scanned.truncatedGenerated)
      for (const file of scanned.files) merged.push({ file, label: root.label })
    }
    merged.sort((a, b) => b.file.mtime - a.file.mtime)

    const items = []
    for (const { file, label } of merged) {
      const item = toListItem(file, label)
      if (!includeBare && item.hasMeta !== true) continue
      if (query !== '') {
        const haystack = `${item.name} ${item.prompt ?? ''} ${item.negativePrompt ?? ''}`.toLowerCase()
        if (!haystack.includes(query)) continue
      }
      items.push(item)
    }

    sendJson(res, 200, {
      ok: true,
      total: items.length,
      offset,
      limit,
      truncated,
      items: items.slice(offset, offset + limit),
    })
  }

  const handleMeta = (url, res) => {
    const roots = rootsOf(ctx, settings)
    const target = url.searchParams.get('path') ?? ''
    if (!isAuthorized(target, roots)) {
      sendJson(res, 403, { ok: false, error: 'forbidden', message: '这个路径不在相册的白名单里。' })
      return
    }
    const meta = readFullSidecar(target)
    if (meta === undefined) {
      sendJson(res, 404, { ok: false, error: 'no-metadata', message: '这张图片没有可读的元数据（sidecar）。' })
      return
    }
    sendJson(res, 200, { ok: true, meta })
  }

  const handleWorkflow = (url, res) => {
    const roots = rootsOf(ctx, settings)
    const target = url.searchParams.get('path') ?? ''
    if (!isAuthorized(target, roots)) {
      sendJson(res, 403, { ok: false, error: 'forbidden', message: '这个路径不在相册的白名单里。' })
      return
    }
    const meta = readFullSidecar(target)
    const workflow = meta?.workflow
    if (workflow === undefined || workflow === null) {
      sendJson(res, 404, { ok: false, error: 'no-workflow', message: '这张图片没有记录工作流。' })
      return
    }
    const body = `${JSON.stringify(workflow, null, 2)}\n`
    const filename = `${path.basename(target, path.extname(target))}.workflow.json`
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Disposition': `attachment; filename="${filename.replace(/["\\]/g, '_')}"`,
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  const handleFile = async (url, res) => {
    const roots = rootsOf(ctx, settings)
    const target = url.searchParams.get('path') ?? ''
    if (!isAuthorized(target, roots)) {
      sendJson(res, 403, { ok: false, error: 'forbidden', message: '这个路径不在相册的白名单里。' })
      return
    }
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      sendJson(res, 404, { ok: false, error: 'missing', message: '文件已经不在了。' })
      return
    }
    if (!stat.isFile()) {
      sendJson(res, 400, { ok: false, error: 'not-a-file', message: '路径不是文件。' })
      return
    }
    if (url.searchParams.get('thumb') === '1') {
      const thumb = await ensureThumb(target, stat)
      if (thumb !== undefined) {
        try {
          const thumbStat = fs.statSync(thumb)
          res.writeHead(200, {
            'Content-Type': 'image/webp',
            'Content-Length': thumbStat.size,
            'Cache-Control': 'private, max-age=86400',
          })
          const thumbStream = fs.createReadStream(thumb)
          thumbStream.on('error', () => { res.destroy() })
          thumbStream.pipe(res)
          return
        } catch { /* 缩略图刚被清掉：回退原图 */ }
      }
    }
    res.writeHead(200, {
      'Content-Type': mimeOf(target),
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=86400',
    })
    const stream = fs.createReadStream(target)
    stream.on('error', () => { res.destroy() })
    stream.pipe(res)
  }

  const handleDelete = (url, res) => {
    const roots = rootsOf(ctx, settings)
    const target = url.searchParams.get('path') ?? ''
    if (!isAuthorized(target, roots)) {
      sendJson(res, 403, { ok: false, error: 'forbidden', message: '这个路径不在相册的白名单里。' })
      return
    }
    if (!IMAGE_EXTS.has(path.extname(target).toLowerCase())) {
      sendJson(res, 400, { ok: false, error: 'not-an-image', message: '只能删除图片，路径看起来不是图片。' })
      return
    }
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      sendJson(res, 404, { ok: false, error: 'missing', message: '文件已经不在了。' })
      return
    }
    if (!stat.isFile()) {
      sendJson(res, 400, { ok: false, error: 'not-a-file', message: '路径不是文件。' })
      return
    }
    const sidecar = `${target}.json`
    const removed = []
    try {
      fs.unlinkSync(target)
      removed.push(target)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { ok: false, error: 'delete-failed', message: `删除失败：${message}` })
      return
    }
    // sidecar 是附属品：删不掉也只是残留一个孤儿文件，不该掩盖图片已删的事实。
    try {
      if (fs.existsSync(sidecar)) {
        fs.unlinkSync(sidecar)
        removed.push(sidecar)
      }
    } catch { /* 保留孤儿 sidecar，下次扫描不会再列出它 */ }
    scanCache.clear()
    sendJson(res, 200, { ok: true, removed })
  }

  const routes = {
    '/roots': (_url, res) => handleRoots(res),
    '/items': handleItems,
    '/meta': handleMeta,
    '/workflow': handleWorkflow,
    '/file': handleFile,
    '/delete': handleDelete,
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sub = url.pathname.slice(PREFIX.length) || '/'
      const writable = sub === '/delete'
      const methodOk = writable
        ? (req.method === 'POST' || req.method === 'DELETE')
        : (req.method === 'GET' || req.method === 'HEAD')
      if (!methodOk) {
        sendJson(res, 405, {
          ok: false,
          error: 'method-not-allowed',
          message: writable ? '删除接口只接受 POST / DELETE。' : '这个接口是只读的。',
        })
        return
      }
      if (sub === '/') {
        sendJson(res, 200, { ok: true, plugin: name, version: VERSION })
        return
      }
      const route = routes[sub]
      if (route === undefined) {
        sendJson(res, 404, { ok: false, error: 'unknown-route', message: `没有这个接口：${sub}` })
        return
      }
      await route(url, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal', message })
      else res.destroy()
    }
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {unknown} config loader 配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const server = ctx.get('webServer')
  if (server === undefined || typeof server.register !== 'function') {
    console.warn('[comfyui-album] 拿不到 webServer 服务，相册 API 未注册。')
    return
  }
  const handler = createHandler(ctx, settings)
  ctx.effect(() => server.register({ kind: 'prefix', path: PREFIX, handler }), 'comfyui-album: http routes')
  const roots = rootsOf(ctx, settings)
  console.info(`[comfyui-album] v${VERSION} 相册 API 就绪：${PREFIX}（${roots.length} 个根目录，最大深度 ${settings.maxDepth}）`)
}
