# 架构

[English](ARCHITECTURE.md) · [Русский](ARCHITECTURE.ru.md) · [简体中文](ARCHITECTURE.zh-CN.md)

## 应用更新

主进程管理统一的更新服务及 `idle`、`checking`、`available`、`downloading`、`ready`、`installing`、`upToDate`、`error` 状态。Preload 仅向可信 renderer 提供检查、下载、安装、当前状态和状态订阅。更新来源仅为 `howdeploy/CanvasTTY` 的稳定版发布。应用启动 30 秒后检查，此后每小时检查一次，也可手动检查。下载和安装分别需要用户操作。

macOS 适配器先缓存归档，再启动 Sparkle；Sparkle 2 在替换应用前验证 Ed25519 签名。Windows NSIS 与 Linux AppImage/deb 使用 `electron-updater`，关闭自动下载和退出时自动安装。Windows 便携版提供手动安装的发布页链接。

## 应用诊断

`DiagnosticLog` 在 `userData/logs` 中保存有界事件日志：四个文件，每个最多 1 MiB。记录启动、关闭、会话状态、更新状态和 main/renderer/IPC 错误，不订阅 PTY 输出或用户输入。写入磁盘和发送报告前均通过现有安全注册表进行机密脱敏。

`diagnosticIpc` 仅接受受信任主 frame 的调用。用户明确点击后，通过 manifest 中配置的 HTTPS 地址发送报告，并核对返回的报告标识符。独立接收服务和域名配置说明见 [diagnostics.md](diagnostics.md)。没有自动上传。

## 进程边界

CanvasTTY 遵循 Electron 的三层模型：

```text
React renderer
    │ 类型化 window.canvasTTY API
    ▼
preload bridge (contextBridge)
    │ 白名单 IPC channel
    ▼
Electron main process
    ├── SettingsStore  → 已校验的原子 JSON 持久化
    ├── TerminalManager → node-pty lifecycle、有界 scrollback 与输出 batching
    ├── LimitsService  → 脱敏后的服务商限额 adapter 与 cache
    ├── PluginManager  → GitHub 安装、manifest、assets、permissions、storage
    ├── PluginSecretsService → 操作系统保护的插件凭据加密与 fail-closed 可用性
    ├── PluginMediaService → 用户授权媒体目录、ranged audio stream、playlist
    ├── BrowserService → 内置 tab 与隔离 WebContentsView lifecycle
    ├── MaterialService → 画布素材：按 realpath 授权、实时状态、版本、批注、草稿、场景
    │   └── MaterialBlobs → 共享配额下按内容寻址的版本与截图 blob
    ├── HandoffService / HandoffResults → 交接包、经校验的粘贴投递、turn 追踪、结果目录
    ├── canvastty-plugin:// → 受 CSP 限制的静态 plugin resource
    ├── canvastty-media:// → 权限检查后的本地音频流
    ├── canvastty-material:// → 素材、版本与场景步骤的只读流
    └── 原生 dialog/window control
```

- `src/shared/contracts.ts` 是进程之间唯一的公共契约。跨进程数据的新增或修改必须先在这里声明。
- `src/preload/index.ts` 只暴露 renderer 需要的类型化能力。Node integration 保持关闭，context isolation 与 sandbox 保持开启。
- `src/main/ipc/registerIpc.ts` 负责原生 side effect，并校验对持久化媒体的访问。
- `src/main/services/TerminalManager.ts` 是实时会话状态与 PTY buffer 的事实来源。它保存有界 scrollback，并将 PTY data 合并为 16ms IPC batch。普通终端从 `idle` 开始；智能体在收到首个机器可读 provider lifecycle signal 前保持 `unavailable`。之后 Codex、Claude Code、Qwen Code、Kimi Code、OpenCode、Hermes 与 Grok Build 通过 provider hook 在 `idle`、`working` 和 `needs_approval` 之间切换；Claude/Qwen 的精确 OSC 0/2 marker 保留为兼容 fallback。不会根据 PTY 是否存在或人类可读终端文字推断活动。进程退出只产生 `done` 或 `failed`。
- `src/renderer/src/features/terminal/webglContextPool.ts` 决定哪些终端卡片使用 xterm 的 WebGL renderer。Chromium 每个 renderer 进程最多保留 16 个 WebGL context，因此池只分配 10 个：先给聚焦的卡片，再按屏幕可见面积（持有 context 且仍活跃的卡片，面对面积不足其 1.25 倍的卡片时保留 context），最后按最近输出。镜头与布局变化需静止 200 ms 后才会移动 context；离开屏幕、缩放超过 1× 或进入摘要模式的卡片立即释放（并显式丢弃）context。其余卡片使用 DOM renderer。context 丢失时卡片回到 DOM，buffer 不变，并在 30 s 内（重复丢失时翻倍）不再使用 WebGL；回到 DOM 时重新 fit 网格，因为 WebGL 的 cell 宽度向下取整到整数设备像素。
- `src/main/services/LimitsService.ts` 通过已安装 CLI 的 app-server protocol 读取 Codex，并通过服务商 usage/billing endpoint 读取 Claude、Kimi、OpenCode Go 与 Grok Build。Qwen Code 是多服务商 CLI，没有 provider-neutral quota-read protocol，因此其 adapter 明确返回 `cli-not-found` 或 `unsupported-protocol`，不会伪造百分比。凭据只在可信主进程读取，只通过 HTTPS 发往匹配的服务商，不记录也不通过 IPC 暴露。该服务负责 timeout、structural normalization、cache、stale fallback 与子进程 cleanup；原始服务商响应不会跨越 IPC。
- `src/main/services/SettingsStore.ts` 会规范化每次更新，并通过串行原子写入持久化。
- `src/main/services/PluginManager.ts` 安装已构建的静态仓库，不执行 package script；拒绝 symlink 与超大包；持久化启用 registry；只提供包内文件，并执行每插件 permissions/storage quota。
- `src/main/services/PluginSecretsService.ts` 串行化每个插件的机密写入，通过 Electron `safeStorage` 加密完整的有界 payload，拒绝 plaintext-only backend，并在卸载时删除加密文件。`ProviderSecretsService.ts` 将同一架构应用于面向 BYOK CLI 的服务商 API key：值只留在 main 进程，renderer 契约只暴露每个 key 的 `configured` 标志与 set/clear 操作。`ApiProfile` 设置项为同一批 BYOK 运行时命名 model 后端（协议、HTTPS base URL、secret 引用）；它们不是 agent provider，且 settings normalizer 会丢弃而非修复无效 profile。
- `src/main/services/PluginMediaService.ts` 仅在原生目录选择后保存授权，隐藏绝对路径，跳过 symlink，并以 HTTP Range 提供音频。Playlist 读取限制在授权媒体库内；写入受大小限制，并且只能原子写入 `Playlists/`。
- `src/main/services/BrowserService.ts` 管理内置浏览器的 `WebContentsView` tab。远程页面使用独立 persistent partition，禁用 Node，启用 context isolation/sandbox，并默认拒绝网站权限。这是 core service，不是 runtime 插件能力。
- `src/main/services/agent-runtime/` 是独立且始终启用的 lifecycle 边界，不受 Browser access 开关控制。每个 agent PTY 都为受保护的 user-local socket/pipe 获得独立 capability。Provider command hook 与 OpenCode event plugin 只能提交固定 status enum、受限 event 名称和可选 opaque turn/prompt ID；Gateway 的精确 schema 会拒绝 prompt text、回复、tool input 与任意 telemetry。PTY 退出时 capability 与临时文件都会被撤销。
- Claude、Codex、Qwen 与 OpenCode 使用仅本次启动有效的 lifecycle hook。Kimi、Hermes 与 Grok 只能从 home 配置发现 hook，因此使用由实时 CanvasTTY 会话共享、带 ownership 检查的临时条目。Kimi 与 Hermes 使用 recovery journal 和精确 backup；Grok 使用独立 owned hook 文件。Cleanup 在无并发编辑时逐字恢复原文件，否则只移除 CanvasTTY 自己的条目。
- `TerminalManager` 注入 MCP helper 时不会留下永久的服务商配置变更。Claude Code、Codex 与 Qwen Code 使用 CLI 参数；Qwen 使用一个 inline `--mcp-config`，只覆盖 CanvasTTY 服务名，不隐藏无关用户服务。OpenCode 使用合并后的、仅本次启动有效的 `OPENCODE_CONFIG_CONTENT` 和一条 scoped browser-tool 权限；Kimi 使用 per-run MCP 配置，旧版本则使用带 compare-and-swap 与 recovery journal 的临时配置。Hermes 会在 `HERMES_HOME/config.yaml` 中获得临时 `mcp_servers.canvastty_browser` 配置项（POSIX 默认路径为 `~/.hermes/config.yaml`，Windows 默认路径为 `%LOCALAPPDATA%\hermes\config.yaml`），敏感 capability 值仍以子进程环境变量占位符保存。Kimi 与 Hermes 的临时配置会保留到最后一个所属 PTY 会话结束；若文件未被并发修改，则精确恢复原始字节。若 Hermes 启动意外中断，journal 会在 CanvasTTY 下次启动时修复配置，compare-and-swap 则保留用户的并发修改。其他 MCP 配置项、凭据和文件/shell 权限不会受影响。Qwen、OpenCode 与 Hermes 的 YOLO 都不修改持久权限设置。
- `src/main/services/providerCliRegistry.ts` 是服务商 CLI 发现的唯一职责边界。main 进程启动时，它按 smoke-only override、继承的 `PATH`、平台默认目录、已知用户/服务商目录的顺序，为 `PROVIDER_CLI_DEFINITIONS` 中的每个服务商创建一个共享快照——每个定义声明该服务商可能安装的 executable 命令名（可以与服务商 ID 不同，例如命令为 `mcode` 的服务商），以及可选的已知目录（相对 home 或 Windows LOCALAPPDATA）。可用条目保存绝对 executable、launcher 类型以及补充后的子进程 `PATH`；POSIX 候选必须是可执行文件，Windows 候选必须是受支持的 native 或 batch launcher。`TerminalManager`、`LimitsService`、agent-browser probe 与 provider smoke 共用该快照，不再各自查找命令。CLI 不可用时，系统会在创建 PTY 或临时 browser 配置之前生成 failed session，并提供可复制的已检查路径诊断；限额适配器报告 `cli-not-found`；HOME 行保持隐藏，直到检测到 CLI 后由用户手动选择。若某服务商绑定了远程计算机上的账户或已保存的容器配置，即使本地没有 CLI，启动器仍会显示它。CanvasTTY 不读取 shell startup script。Agents 设置可重新检查候选路径、原子替换 registry 快照、调整已保存的启动器和限额选择，并在无需重启的情况下刷新依赖 CLI 的适配器。运行中的 session 保持不变；新检测到的 CLI 需手动启用。

主 `BrowserWindow` 在 settings、plugins、media 和 IPC 服务初始化之前创建并显示轻量本地启动页。初始化成功后替换为可信 renderer；bootstrap 失败后替换为可见错误页，并保留原生对话框 fallback。主进程持有 Electron single-instance lock；再次启动时恢复并聚焦已有窗口。

Runtime 插件代码绝不会导入主进程或可信 renderer bundle。HOME widget 与 canvas app 在 opaque origin 的 sandbox iframe 中运行。独立插件窗口使用职责狭窄的 preload，通过 IPC handler 转发同一 message SDK；handler 根据实际 sender URL `canvastty-plugin://<id>/<entry>` 校验 plugin/contribution。任意原生系统窗口不会被嵌入。

插件音乐访问基于 capability，而不是通用文件系统权限。媒体扫描返回 library ID、相对路径、metadata 与 `canvastty-media://` stream URL；原始 playlist 文本是唯一暴露的 format-neutral 文件内容。媒体 URL 只为对应且已启用的插件解析，并且必须位于用户此前选择的 library root 下。卸载插件会撤销其持久化目录授权。

内置浏览器跨两个界面分工：`BrowserCard` 渲染可信的外层 window chrome、tab、navigation、agent badge、download、dialog 与 canvas geometry；`BrowserService` 把活动 native view 定位到卡片测量出的 viewport 上。卡片或 camera 移动时 native view 保持实时渲染，并按帧合并 geometry 更新；仅在 semantic summary、编辑 HOME 或可信 modal 后方隐藏。Fractional renderer bounds 扩展到完整覆盖的 device-independent pixel；只有活动 tab 实际变化时才重新挂接 view。Typed pointer bridge 把 native page 的 click/hover activity 返回 canvas selection，并显式恢复页面焦点而不阻止页面输入。仅连接或 heartbeat 不会创建 presence：实际 browser command 后才显示 badge，获得真实 pointer position 后才显示 cursor。

## 素材、批注与交接

素材是画布上本地文件与截图的卡片。`src/main/services/materials/MaterialService.ts` 拥有素材、版本、批注与草稿；`HandoffService.ts` 构建并投递交接包；`HandoffResults.ts` 监视结果目录并读取 `canvastty-report-<n>.json`。renderer 只能看到 ID、显示路径与 `src/renderer/src/features/materials/*` 中的类型化结果。共享常量与限制在 `src/shared/materials.ts`。文件与版本的字节只通过 `canvastty-material://` 只读提供，支持 HTTP Range、`no-store` 与 `nosniff`。

状态仅在开启 **退出后保存素材** 时写入 `userData/materials/state.json`（`0600`、原子写入、debounce）；文本草稿是 `userData/materials/drafts/` 下独立的 `0600` 文件。若 `state.json` 无法解析，会被移到 `state.json.broken-<timestamp>` 并以空状态启动。版本是 `userData/materials/versions/` 下按内容寻址的 blob：总配额 1 GB，单个版本最多 256 MB，单次截图最多 32 MB，每个素材最多 20 个版本。大于 256 MB 的视频/音频会返回明确错误，不会生成版本。被固定的版本不会被清理；否则超出限制时最旧的无引用版本会被静默淘汰，而当无可淘汰时，操作会返回明确的 `version-limit` 错误。交接包位于 `userData/materials/handoffs/<id>/`：最多 50 个文件夹，单个包最多 512 MB，总计最多 1 GB，在启动和每次发送后清理。关闭 **退出后保存素材** 会在启动和退出时清除 `versions/` 与 `handoffs/`，并写入空状态。

拖入、选择或粘贴的文件成为针对其 realpath 的授权。每次读取都以 `O_NOFOLLOW | O_NONBLOCK` 重新打开文件，要求是普通文件，并在路径已指向别处时拒绝。文件身份是 `stat` 中的 `dev`/`ino`。相同内容即使 `mtime`/`ino` 改变也仍是当前版本；仅改变大小写的重命名会在确认同一 inode 且排除 symlink 后提示为“已移动”。交接结果目录每次扫描都会解析为 realpath，若 realpath 不可读则退回最近一次已知路径，并在窗口结束后十分钟或应用退出时停止监视。移除卡片不会触碰原文件；其固定版本以及仅存在于 CanvasTTY 中的截图会随之删除。文本编辑仅在磁盘哈希仍等于编辑基准时保存（compare-and-swap），通过同目录临时文件与 rename 完成，并保留文件权限、换行符与 BOM；被替换的内容保留为一个版本。

查看文件时绝不以应用权限执行其内容。图片、视频与音频经 `canvastty-material://` 提供。文本按 UTF-8 解码并作为纯文本渲染。PDF 字节在 main 中经 IPC 读取，由 pdf.js 在 worker 中解析，禁用脚本、XFA 与 WebAssembly。

批注固定其针对的确切版本与锚点：图片上的 `point`/`region`、文本中的 `lines`、视频/音频中的 `time`/`span`、PDF 的 `page`，或场景中的 `step`，也可以是整个素材 `whole`。批注最多 2000 条，每条不超过 2000 字符。文本摘录附带行号。批注可引用另一素材，两侧都会校验。`reported` 只来自 agent 的报告文件，`accepted` 只来自人。更新通过 `MaterialService` 的串行队列原子完成。

交接通过 `TerminalManager.deliverInput` 以 bracketed paste 送入现有终端会话。只有 Claude Code 与 Codex 拥有已验证的粘贴契约：它们的文本与图片路径会先由 headless xterm 镜像确认，再按下 Enter，或者由所选结果目录中的 `canvastty-report-<n>.json` 确认。其他 agent 只收到文本、不会按 Enter，结果为 `pasted`，并注明 `not-observed`、`not-seen` 或 `enter-failed` 之一。向正在发送的会话再次发送会被拒绝为 `busy`，而重复使用同一交接 id 会被拒绝为 `already-sent`。组合文本会去除终端控制字符，完整文本始终写入交接包的 `handoff.md`。Turn 的开始与结束只取自同一次会话运行的 lifecycle 状态；投递不代表 agent 已阅读或完成任何内容。

可选的结果目录会在交接的 turn 时间窗内被监视。新文件成为结果卡片，`canvastty-report-<n>.json` 可将批注标记为 `reported`。只有当恰好一个交接的时间窗能解释该变更时，文件才归属于该交接；否则来源显示为未知。

页面截取与场景录制只使用 renderer 的公开浏览器 API：`browser_screenshot`、`browser_observe`、`getState` 与 `onState`。截取区域以 `BrowserCard` 渲染的 `.browser-card__viewport` 为基准。其 UI 位于 Browser 卡片之外。录制由用户显式开始与停止，上限为 30 步或 15 分钟，仅限开始时的标签页，不记录按键，URL 去掉 query 与 fragment。保存前 URL 会被 sanitised：高熵路径段替换为 `…`。密码字段由浏览器核心掩码，但普通表单文本在截图中可见。renderer 重载后仍然存活的录制（例如页面重载后）会由 main 的定时器以 `limit` 结果关闭。视频帧从可见视频区域截取后交给 `captureFrame`。

## Renderer 边界

`App.tsx` 是编排边界。它加载 settings/session，订阅主进程事件，并协调 dialog 与持久化。Feature component 不调用无关 feature 的 API。

```text
App
├── WorkspaceCanvas        camera、pan、zoom、空间组合
│   ├── HomeZone           持久化网格、边界与编辑手势
│   │   ├── homeModel      纯函数派生限额/活动会话行
│   │   └── HomeMediaWidget 独立的 pick/replace/remove control
│   ├── TerminalCard       xterm、selection、rename、drag、resize、snap
│   ├── PluginCanvasCard   带 bounds 与 summary 的 sandbox plugin app
│   ├── MaterialCard       文件、截取与场景卡片：带批注的 image、text、media、PDF 与 scenario body
│   └── BrowserCard        可信 browser chrome 与 native view geometry
├── HandoffDialog          接收方、批注、文件、精确预览与投递结果
├── CompareDialog          前后图片或逐行 diff，然后接受或退回
├── AgentLaunchDialog      固定 provider + folder + profile + launch
└── SettingsPanel          General、Appearance、Controls、Plugins
    └── PluginSettingsSection preview、permissions、registry、contribution
```

领域决策放在 `homeModel.ts` 等纯 selector 中，编排放在 `App.tsx`，渲染/本地交互放在 feature component。IPC call 属于 `App.tsx` 或唯一拥有该 capability 的 feature。

## 会话流程

1. Home 请求终端，或打开某个服务商专属的 launch card。
2. `App` 发送类型化 `terminal:create` 请求。
3. `TerminalManager` 校验请求、启动 PTY、保存 metadata 和有界分块 scrollback，然后发送 lifecycle event 与 16ms batch data event。
4. `App` 按 session ID 协调 lifecycle snapshot。
5. `TerminalCard` 订阅 PTY stream，发送 PTY input/grid resize，并在 drag 或 edge resize 完成后提交类型化 canvas bounds。

`SessionMetadata` 同时拥有 world-space position 与卡片尺寸。`App` 协调 bounds；`TerminalCard` 可以在 pointer-up 前暂存 pointer-move geometry。主进程在发送 session snapshot 前校验并限制已提交尺寸。Camera wheel 只处理空白 canvas；交互界面保留自己的 native scroll/input ownership。

Camera 不是 React state。`App` 持有 `cameraStore`（`features/workspace/cameraStore.ts`）；`WorkspaceCanvas` 在 store 的 listener 中同步写入场景 transform，早于任何测量场景的组件渲染。只有小地图和 `BrowserCard` 订阅每次移动；卡片订阅派生值（`useCameraSelector`：摘要缩放、WebGL 资格），拖拽处理函数在移动时读取 `camera.get().zoom`，因此平移或缩放不会渲染卡片。

一个实时 `TerminalCard` 在对应 session ID 的整个生命周期内拥有同一个 xterm instance。切换 palette 时就地更新 `terminal.options.theme`；title/settings 变化不得销毁 terminal 或 renderer scrollback。窗口标题通过 `terminal:rename` 作为 session metadata 更新。与进程退出竞态的 PTY input/resize event 在主进程边界内处理，不会形成未捕获 Electron error。

输出 batching 是 IPC/rendering 边界，而不是历史边界：每个 PTY chunk 都立即追加到有界 scrollback；待发送的 renderer 输出在 16ms timer、exit 前和 dispose 前 flush。所有会话共用一个 timer：同一次 flush 的 renderer 输出由 `TerminalRendererOutbox` 作为一条 `terminal:data-batch` 消息发送（session/removed 事件会先 flush 之前收集的输出，保持顺序）；preload 只把事件交给对应会话的卡片（`TerminalDataRouter`）。Scrollback trimming 通过推进 chunk 完成，不会每次写入都重建整个 buffer；snapshot 只 join 保留的后缀。

终端指针坐标在 selection/wheel handling 前，从画布视觉变换后的矩形转换回 xterm layout 坐标。终端与画布滚轮方向从持久化设置中独立规范化。选中文字通过类型化 clipboard bridge 使用 `Ctrl+C`、`Ctrl+Shift+C` 或 `Cmd+C` 复制；使用 `Ctrl+Shift+V`、`Cmd+V` 或 `Shift+Insert` 粘贴，并通过 `Terminal.paste` 而非 synthetic keystroke 进入 xterm。`Shift+Enter` 直接向 PTY 发送 CSI-u modified Enter。

Application shortcut 在 `SettingsStore` 中规范化，在 `App` 中匹配，并从同一持久化 binding 渲染到 canvas hint。`App` 拥有排他的 canvas application selection，以及窗口 rename 等操作使用的 selected terminal session；`TerminalCard` 拥有 xterm focus 与 inline editor，`BrowserService` 拥有 native page focus。点击空白 canvas 会清除任一 selection。可选 hover focus 对终端与内置 Browser 使用相同的进入/离开配置延迟；终端程序化切换产生的 focus-in/focus-out sequence 会在进入 PTY input 前被抑制，避免智能体 TUI 重置历史位置。

Session counter、progress bar 与 status 必须来自真实 `SessionSnapshot`，UI 不得合成 telemetry。

## 服务商限额流程

1. `App` 在 bootstrap 时以及每 60 秒请求脱敏后的 `LimitsSnapshot`。
2. `LimitsService` 对 refresh 去重，并维护 60 秒 cache。
3. Codex 通过 `codex app-server` 的 `account/rateLimits/read` 查询；Claude、Kimi、OpenCode Go 与 Grok Build 使用只读 usage/billing endpoint 和对应 CLI 已有凭据。Qwen Code 因没有通用 quota-read protocol 而返回明确 unavailable reason。OpenCode Go 提供真实 rolling、weekly、monthly window；Grok Build 提供真实共享 billing period。真实响应经过结构校验，只保留 percentage、window 与 reset time。
4. 一次成功后刷新失败时，最后的有效 snapshot 以 stale 返回。缺失或不支持的 adapter 返回明确 unavailable reason，而不是 `0%`。
5. CanvasTTY 使用当前用户 Claude CLI credentials 中的 OAuth token 请求 Claude usage。缺失或不可读的 credentials 返回 `not-authenticated`；本地 credential 状态不能证明用户没有订阅。CanvasTTY 不解析服务商 TUI screen。

## 扩展点

- 新增 provider 时，在 `ProviderId`、`providers.ts`、`TerminalManager.resolveLaunch`、官方 provider asset map 和可选的安全 limit adapter 中添加。
- 新增持久化 setting 时，在 `AppSettings`、`SettingsStore` defaults/normalization 与唯一归属 feature 中添加。Settings 负责面向用户的 canvas control 与 shortcut；camera math 和 snapping geometry 保持为纯 renderer concern。
- 新增 canvas entity 时，使用独立 feature component，声明明确 position 与 callback；camera ownership 保留在 `WorkspaceCanvas`。
- 新增素材种类时，先在 `src/shared/contracts.ts` 扩展 `MaterialKind`，再在 `src/main/services/materials/materialState.ts` 的 `KINDS` Record 中添加该种类（TypeScript 会强制要求补齐）。接着在 `normalizeMaterial` 中添加规范化，在 `src/shared/materials.ts` 的 `materialType` 与 `DEFAULT_SIZES` 中添加映射，在 `anchorFits` 与 `remarkAnchorLabel` 中补全 switch，在 `src/main/services/materials/handoffText.ts` 的 `describeAnchor` 中添加描述文本，并在 `src/renderer/src/features/materials/` 的 `MaterialCard` 中添加 body 组件。
- 发布 runtime extension 时，使用 `canvastty.plugin.json` API v1 与静态 HTML/CSS/JS entry。Contribution kind 为 `home-widget`、`canvas-app`、`window`；capability access 受 manifest permission 限制。参见[运行时插件](plugins.zh-CN.md)。

每项扩展都应通过 `npm run typecheck`、`npm run build`，并在真实 Electron 中完成交互检查。
