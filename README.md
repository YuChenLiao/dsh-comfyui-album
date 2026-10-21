# dsh-comfyui-album

> **这是 [`dsh-comfyui-image`](https://github.com/wbb316/dsh-comfyui-image) 的辅助插件。**
> 它自己不出图，只负责把那个插件已经生成在磁盘上的图片收成相册：侧边栏有入口，鼠标悬浮到图片上就能复制图片、复制提示词、导出工作流、加入当前对话、删除。

## 兼容插件

| 插件 | 关系 | 仓库 |
| --- | --- | --- |
| `dsh-comfyui-image` | **配套（相册的数据来源）**：读取它落盘的图片与同名 `<图片>.json` sidecar，以及它配置里的 `outputDir`。不 import 它的任何代码，所以它升级不会把相册拖垮；没装时相册只会是空的。 | [wbb316/dsh-comfyui-image](https://github.com/wbb316/dsh-comfyui-image) |
| `dsh-better-sidebar` | **可选（增强入口）**：检测到它的 `ctx.betterSidebar` 服务时，把相册注册成一个侧栏页签（`comfyui-album:gallery`），可在其 `+` 菜单或原生右栏里打开。没装时这段注册静默缺席，不影响主侧边栏入口。 | [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) |

## 安装

```sh
# 从 GitHub 安装（<profile> 换成你的 profile 名，常见的是 desktop 或 web）
dsh plugin --profile <profile> add github:YuChenLiao/dsh-comfyui-album

# 本地开发：直接把目录 link 进 profile
dsh plugin --profile <profile> add link:/path/to/dsh-comfyui-album
```

装完刷新一下页面（Web GUI 要重新加载客户端 bundle）。已在 DSH `0.2.1-rc.2` 上验证；前置是先装好 [`dsh-comfyui-image`](https://github.com/wbb316/dsh-comfyui-image)，否则相册里没有东西可看。

## 界面

### 入口

![左侧栏的相册入口，以及 better-sidebar 新建菜单里的相册页签](docs/screenshots/01-sidebar-entry.webp)

左侧栏「相册」一项就是主入口，点开后在中央面板显示相册。同一套页面也会注册进 `dsh-better-sidebar`，所以在它的起始页页签列表里能看到「相册」（截图右侧）。中央主面板顶部另有「在侧边栏打开」按钮，用于就地跳到侧栏页签；没装该插件时按钮会给出提示，而不是静默失败。

### 相册面板

![相册面板：顶部工具栏、缩略图网格、每张图下方的提示词与参数](docs/screenshots/02-gallery-panel.webp)

顶部一行是全套筛选：相册计数、按提示词或文件名搜索、目录下拉、`仅生成图 / 含全部图片` 切换、重新扫描。下面是缩略图网格，卡片底部直接给出提示词开头与「尺寸 · seed · 模型」。滚动到底部会自动续页，拉完即停。

### 悬浮操作

![鼠标悬浮时出现五个按钮：复制图片、复制提示词、导出工作流、添加到当前对话、删除](docs/screenshots/03-card-hover.webp)

鼠标移到任意一张图上，右上角浮出五个按钮，从左到右：复制图片、复制提示词、导出工作流、添加到当前对话、删除。删除会先弹确认框，不会误点就抹掉文件。

### 图片详情

![大图预览与右侧参数栏：尺寸、种子、底模、采样、步数、CFG、模式、生成时间、路径，以及提示词与负向提示词全文](docs/screenshots/04-image-detail.webp)

点开任意一张图是大图预览，右侧列出全部可复现参数与提示词全文（含负向提示词），同样的五个操作在这里也能用。

## 它怎么找图

不建数据库 —— 相册直接扫磁盘上的产物：

- 图片（`.png` / `.jpg` / `.webp` / `.gif` / `.avif` / `.bmp`）
- 同名 sidecar `<图片>.json`（`dsh-comfyui-image` 的 `writeMetadata` 默认开启，里面带 prompt、负向提示词、seed、尺寸、步数、CFG、模型、采样器和完整 workflow）

默认只看带 sidecar 的图（也就是这个插件真正生成的那些）；面板上的「仅生成图 / 含全部图片」可以切换成目录里的所有图片。

扫描根目录：显式配置 → 当前工作目录 → 全部 workspace → `dsh-comfyui-image` 配置里的 `outputDir` → 进程 cwd。一轮扫描按目录缓存 4 秒，面板上的刷新按钮会强制重扫。

列表里的缩略图由宿主按需生成（`sharp`，360px WebP，落盘缓存）。`sharp` 不可用时静默回退原图，不影响使用。

## 五个悬浮操作

| 操作 | 行为 |
| --- | --- |
| 复制图片 | 写进系统剪贴板（非 PNG 会先转 PNG —— 剪贴板只认 PNG） |
| 复制提示词 | 复制 sidecar 里的正向提示词 |
| 导出工作流 | 下载 `<文件名>.workflow.json`（ComfyUI API 格式，可直接喂 `/prompt`） |
| 添加到当前对话 | 先切回对话，再以「粘贴图片」的方式把图放进输入框草稿（等你补文字再发） |
| 删除 | 过一层确认框，确认后删除图片与同名 sidecar（不可撤销） |

## 配置

在 profile 的 `cordis.patch.yml` 里给本插件那行加 `config`：

```yaml
- id: dsh-comfyui-album
  name: dsh-comfyui-album
  config:
    roots: ['D:\Comfy-Desktop\output']  # 额外纳入相册的目录
    maxDepth: 3        # 扫描深度，0 = 只看根目录本身
    maxItems: 4000     # 单个根目录最多收集多少张图
    cacheMs: 4000      # 列表缓存毫秒数
    includeHidden: false
```

## API

挂在 `/comfyui-album/api` 下：

- `GET /roots` — 允许读取的根目录
- `GET /items?root=&q=&offset=&limit=&all=1&refresh=1` — 相册列表
- `GET /meta?path=` — 单张图片的完整 sidecar
- `GET /workflow?path=` — 工作流下载
- `GET /file?path=&thumb=1` — 图片字节（`thumb=1` 取缩略图）
- `POST /delete?path=` — 删除图片与同名 sidecar，返回 `{ ok, removed }`（唯一写接口）

`path` 一律校验必须落在白名单根目录内，越界返回 403；`/delete` 只接受 `POST`/`DELETE`，其它接口只读（非 `GET`/`HEAD` 一律 405）。

## 自检

```sh
npm test
```

- `tests/smoke.mjs`：起一个临时 HTTP server 跑宿主 API，覆盖列表/筛选/分页越界/元数据/工作流下载头/图片字节/缩略图，以及删除、越权 403、未知路由 404、非 GET 405。
- `tests/render.mjs`：用 `react-dom/server` 把 `Card` / `Lightbox` / `Gallery` / 删除确认层渲一遍，并用纯函数 `planPage` 钉住“续页何时停手”的分页决策。

## 已知限制

- 「添加到当前对话」走的是宿主自己的粘贴链路（向输入框派发带 `File` 的 `paste` 事件），和用户手动 Ctrl+V 完全一致；找不到输入框时会退化成「图片已复制到剪贴板」。
- 剪贴板写入需要安全上下文（`127.0.0.1` 满足），浏览器拒绝时会给出明确提示。
- 删除是直接 `unlink`，不进回收站；确认框是唯一的防线，删之前想清楚。
- 缩略图对 GIF 只取首帧；大图预览仍然是原图。

## 致谢

- **[dsh-comfyui-image](https://github.com/wbb316/dsh-comfyui-image)**：它把 prompt、seed、采样参数和完整 workflow 都写进了图片旁边的 sidecar，并坚持“文件名带时间戳、绝不覆盖”的落盘规则。相册因此不需要自建索引，删掉 sidecar 缓存也能随时重建。
- **[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)**：开放的 `ctx.betterSidebar` 注册接口和清楚的接入文档，让一个第三方页面能直接作为页签嵌进它的侧栏，而不用去猜宿主内部结构。
- **DeepSeek Harness**：`webServer` 路由、`sidebar.panellist` 与 `main` 面板这套插槽设计，让相册能以插件方式挂在原生侧边栏上；本地 ComfyUI 则提供了实测出图的真实环境。

## 许可

MIT
