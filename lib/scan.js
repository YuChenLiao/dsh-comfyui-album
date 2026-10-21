/**
 * 相册的磁盘扫描与元数据读取。
 *
 * 数据源是 dsh-comfyui-image 的产物约定：图片落在磁盘上，同目录同名
 * `<图片>.json` 是它的 sidecar（含 prompt / seed / 参数 / 完整 workflow）。
 * 所以「相册」= 能扫到图片 + 能读到 sidecar 的那些文件，不需要插件间耦合。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 认作图片的扩展名。 */
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'])

/** 扫描时直接跳过的目录：既不是用户资产，也会把一次扫描拖成几秒。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.dsh', '.cache', '.next', '.turbo',
  '__pycache__', '.venv', 'venv', 'dist', 'build', 'target', 'coverage',
])

/** sidecar 体积上限：自定义工作流可能很大，但读进内存要有界。 */
const SIDECAR_MAX_BYTES = 8 * 1024 * 1024

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
}

/**
 * 图片扩展名对应的 MIME。
 * @param {string} filePath 文件路径。
 * @returns {string} 用于响应的 Content-Type。
 */
export function mimeOf(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 一张图片的 sidecar 路径。
 * @param {string} imagePath 图片绝对路径。
 * @returns {string} sidecar 绝对路径。
 */
export function sidecarPathOf(imagePath) {
  return `${imagePath}.json`
}

/** sidecar 解析缓存：键为图片路径，值为 mtime 与解析结果。 */
const sidecarCache = new Map()

/**
 * 读取并缓存一张图片的 sidecar。
 *
 * 缓存按 sidecar 的 mtimeMs 失效：重新生成同名文件（改名策略下极少见）也能读到新内容。
 * 任何读取或解析失败都返回 undefined —— 相册不该因为一个坏文件整体失败。
 * @param {string} imagePath 图片绝对路径。
 * @returns {Record<string, unknown> | undefined} sidecar 内容。
 */
export function readSidecar(imagePath) {
  const metaPath = sidecarPathOf(imagePath)
  try {
    const stat = fs.statSync(metaPath)
    if (!stat.isFile() || stat.size === 0 || stat.size > SIDECAR_MAX_BYTES) return undefined
    const cached = sidecarCache.get(imagePath)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.meta
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    const meta = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
    sidecarCache.set(imagePath, { mtimeMs: stat.mtimeMs, meta })
    return meta
  } catch {
    sidecarCache.delete(imagePath)
    return undefined
  }
}

/** @param {unknown} value @returns {string | undefined} */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * 截断超长文本。列表一次返回几十条，提示词不设上限时响应会被个别巨型提示词撑爆；
 * 1200 字符足够覆盖实际提示词，也够灯箱展示。
 * @param {string | undefined} value 原文本。
 * @param {number} max 上限。
 * @returns {string | undefined} 截断后的文本。
 */
function clip(value, max) {
  if (value === undefined) return undefined
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** @param {unknown} value @returns {number | undefined} */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 从 ComfyUI 工作流里取模型名。
 *
 * 顶层 `checkpoint` 只在插件认出底模时才写；换了 UNET/GGUF 之类的工作流就没有这个字段，
 * 但节点参数里仍然有名字。按节点顺序取第一个权重名，够灯箱展示用。
 * @param {unknown} workflow API 格式工作流。
 * @returns {string | undefined} 模型文件名。
 */
function modelFromWorkflow(workflow) {
  if (workflow === null || typeof workflow !== 'object') return undefined
  for (const node of Object.values(workflow)) {
    if (node === null || typeof node !== 'object') continue
    const inputs = node.inputs
    if (inputs === null || typeof inputs !== 'object') continue
    for (const key of ['ckpt_name', 'unet_name', 'model_name']) {
      const value = inputs[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

/**
 * 把 sidecar 压成列表条目需要的字段。
 * @param {Record<string, unknown> | undefined} meta sidecar 内容。
 * @returns {Record<string, unknown>} 摘要字段。
 */
function metaSummary(meta) {
  if (meta === undefined) return { hasMeta: false }
  return {
    hasMeta: true,
    prompt: clip(text(meta.prompt), 1200),
    negativePrompt: clip(text(meta.negativePrompt), 800),
    mode: text(meta.mode),
    seed: num(meta.seed),
    width: num(meta.width),
    height: num(meta.height),
    steps: num(meta.steps),
    cfgScale: num(meta.cfgScale),
    strength: num(meta.strength),
    samplerName: text(meta.samplerName),
    scheduler: text(meta.scheduler),
    checkpoint: text(meta.checkpoint) ?? modelFromWorkflow(meta.workflow),
    createdAt: text(meta.createdAt),
    workflow: meta.workflow !== undefined && meta.workflow !== null,
  }
}

/**
 * 递归收集一个根目录下的图片。
 *
 * 深度与数量都有上限：相册是浏览入口，不能变成一次全盘 IO。
 * 带 sidecar 的（插件生成物）与普通图片分开计数，保证上限先吃掉普通图片 ——
 * 一个塞满截图的目录不该把真正的生成图挤出相册。
 * @param {string} root 根目录绝对路径。
 * @param {{ maxDepth: number, maxItems: number, includeHidden: boolean }} options 扫描上限。
 * @returns {{ files: Array<{ path: string, name: string, dir: string, size: number, mtime: number }>, truncated: boolean, truncatedGenerated: boolean, truncatedBare: boolean }}
 */
export function collectImages(root, options) {
  const generated = []
  const bare = []
  let truncatedGenerated = false
  let truncatedBare = false
  const walk = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (!options.includeHidden && name.startsWith('.')) continue
      const full = path.join(dir, name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        if (depth + 1 > options.maxDepth) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!IMAGE_EXTS.has(path.extname(name).toLowerCase())) continue
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      const record = { path: full, name, dir, size: stat.size, mtime: stat.mtimeMs }
      if (fs.existsSync(`${full}.json`)) {
        if (generated.length < options.maxItems) generated.push(record)
        else truncatedGenerated = true
      } else if (bare.length < options.maxItems) {
        bare.push(record)
      } else {
        truncatedBare = true
      }
    }
  }
  walk(root, 0)
  const files = generated.concat(bare)
  files.sort((a, b) => b.mtime - a.mtime)
  return { files, truncated: truncatedGenerated || truncatedBare, truncatedGenerated, truncatedBare }
}

/**
 * 文件信息 + sidecar 摘要 → 一条列表项。
 * @param {{ path: string, name: string, dir: string, size: number, mtime: number }} file 扫描结果。
 * @param {string} rootLabel 所属根目录显示名。
 * @returns {Record<string, unknown>} 列表项。
 */
export function toListItem(file, rootLabel) {
  return {
    path: file.path,
    name: file.name,
    dir: file.dir,
    root: rootLabel,
    size: file.size,
    mtime: file.mtime,
    ...metaSummary(readSidecar(file.path)),
  }
}

/**
 * 读取一张图片的完整 sidecar（含 workflow）。导出工作流时用。
 * @param {string} imagePath 图片绝对路径。
 * @returns {Record<string, unknown> | undefined} sidecar 内容。
 */
export function readFullSidecar(imagePath) {
  return readSidecar(imagePath)
}
