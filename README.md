<p align="center">
  <img src="assets/logo/interleaf-logo.svg" width="88" alt="纸间 Interleaf 标识" />
</p>

<h1 align="center">纸间 Interleaf</h1>

<p align="center">本地优先的 EPUB / PDF 阅读器，让论文管理、双语阅读、批注与 AI 精读围绕原文展开。</p>
<p align="center"><b>简体中文</b> · <a href="README.en.md">English</a> · <a href="https://github.com/Tazewell/Interleaf/releases">下载安装</a> · <a href="https://github.com/Tazewell/Interleaf/issues">反馈问题</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/assets/screenshots/interleaf-pdf-dark.jpg" />
  <img src="website/assets/screenshots/interleaf-pdf-light.jpg" alt="纸间 PDF 阅读界面：示例原文、章节目录与对话侧栏" />
</picture>

把图书与论文保存在自己的电脑上，整理文献、标记段落、记下问题，再按需连接自己的模型服务。阅读位置、批注、笔记和对话随文档保存，重新打开后继续阅读。

## 可以做什么

| 阅读场景 | 纸间提供的功能 |
| --- | --- |
| 整理图书与论文 | 分开的图书库与论文库；分类、标签、星标、阅读状态；论文元数据、重复检测、关联文献与可自定义的表格列。 |
| 把资料收进来 | 导入本地 EPUB / PDF；通过 DOI、arXiv、链接或完整标题查找论文；从 Zotero、EndNote 或 BibTeX 迁入资料。 |
| 带着问题阅读 | 目录、全文搜索、书签、高亮、下划线和笔记；保存阅读位置，点击批注或有效回答来源返回原文。 |
| 对照原文与译文 | PDF 原文、对照与译文视图；EPUB 按章翻译；原译文滚动同步、划词翻译、自定义翻译提示词。翻译需要配置模型服务。 |
| 围绕资料提问 | 引用文字或图片，按文档管理多个对话；支持工具调用的模型可按需检索、补读原文，具备图片能力时可查看 PDF 页面。也可围绕分类资料开展主题研究。 |
| 带走阅读成果 | 导出 Markdown、带图片的 ZIP、带批注的原文 PDF；桌面版另支持双语 PDF。引用支持 GB/T 7714、APA、BibTeX、BibLaTeX、RIS 与 CSL-JSON。 |

桌面版还提供快捷键、代理设置、诊断导出、自定义书库位置和应用内更新。`interleaf` 命令行可在应用运行时检索、读取和导入本机书库。

## 从一篇论文开始

下面以 Vaswani 等人的深度学习论文 [Attention Is All You Need（2017）](https://arxiv.org/abs/1706.03762) 演示导入、整理与阅读流程。

界面配图沿用仓库中 **2026-11-05** 拍摄的真实截图，展示项目自带示例文档，不是上述论文的实拍。截图使用独立演示书库，未包含个人 API 配置或模型回答；浅色与深色主图会跟随 GitHub 外观切换。

### 1. 导入资料

在论文库中选择导入，粘贴 `1706.03762`、DOI 或论文链接，也可直接选择本地 PDF。导入前可选择分类；已有 Zotero、EndNote 资料库可先扫描并预览迁移内容。

<img src="website/assets/screenshots/interleaf-import.jpg" alt="纸间论文导入窗口，支持链接与标识、本地文件、文献库迁移和 BibTeX" />

### 2. 整理与查找

用分类和标签收拢同一主题的论文，按阅读状态筛选，按需要调整表格列。PDF 文字索引与精细版面解析分开进行，导入后可先打开原文，待索引就绪后搜索文字。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/assets/screenshots/interleaf-library-dark.jpg" />
  <img src="website/assets/screenshots/interleaf-library-light.jpg" alt="纸间图书库中的 PDF 与 EPUB 示例文档，可按格式、阅读状态与标签筛选" />
</picture>

### 3. 阅读、批注与追问

打开论文后，通过目录或搜索定位，选中文字添加高亮、下划线或笔记。需要 AI 时，将文字或图片加入输入框，输入问题后发送；每篇文档可保留多个独立会话。配置翻译模型后，可按需翻译全文、章节或选区。

<img src="website/assets/screenshots/interleaf-sessions.jpg" alt="阅读界面中的会话管理，可切换、重命名与删除当前文档的对话" />

## 安装与运行

从 [GitHub Releases](https://github.com/Tazewell/Interleaf/releases) 下载适合的安装包。当前发行目标为 **Windows x64**，文件名为 `Interleaf-版本号-win-x64.exe`。安装版已包含本地服务和 PDF 处理器，无需另装 Node.js、Go、Python 或 PaddlePaddle。

Windows 安装包目前没有受信任的开发者签名；可使用发行页的 `SHA256SUMS.txt` 核对下载文件。

### 从源码启动桌面版

准备 **Node.js 22+、pnpm 10.30.3、Go 1.26.5+**，在同一个系统环境中安装依赖并运行：

```sh
git clone https://github.com/Tazewell/Interleaf.git
cd Interleaf
pnpm install --frozen-lockfile
pnpm desktop
```

首次构建会下载并校验约 **67 MB** 的本地 PDF 版面模型，需要网络连接。空图书库可选择“先体验示例文档”。

### 浏览器预览与 WSL

`pnpm dev` 会构建处理器和服务，启动本机后端与 Vite。WSL 中也可使用该方式：在 WSL 内准备上述工具链、安装依赖并启动，再用 Windows 浏览器打开终端输出的完整地址。

```sh
cd /path/to/Interleaf
pnpm install --frozen-lockfile
pnpm dev
```

默认预览地址形如 `http://127.0.0.1:5173/#token=…`。`#token=…` 用于本机 API 鉴权，需要完整保留；不要公开带 token 的地址。浏览器预览不需要启动 Electron。WSL 不能构建 Windows 安装包；打包需在原生 Windows x64 环境执行。

## AI 配置与本地数据

本地阅读、搜索和批注不依赖 AI。在 **设置 → AI** 中选择服务商或自定义 API 地址，填写 Key 与协议，再选择问答、翻译、图片和研究模型。支持 OpenAI 兼容与 Anthropic 协议，内置 DeepSeek、阿里百炼、Kimi、智谱和 MiniMax 地址预设。应用内的 Go 运行时直接调用模型服务，无需安装外部 AI 命令行工具。

图片与工具能力取决于模型和接口，可在模型设置中检测。配置可用模型服务后，新导入且不超过 **50 页**的 PDF 论文默认自动翻译；可在 **设置 → 论文库 → 导入设置** 中调整页数阈值，设为 **0** 后关闭新导入论文的自动翻译。自动划词翻译默认关闭，可在 **设置 → 阅读** 中开启。主题研究的联网检索需要单独允许。

- **本地保存**：原始文件、SQLite 数据库、阅读记录、批注、译文、笔记和会话存放在书库目录，未内置云同步。
- **模型请求**：使用 AI 时，所需原文、选区、图片与会话上下文会发送给配置的模型服务；联网研究还会查询公开学术来源。费用与数据处理政策由对应服务决定。
- **论文信息补全**：导入 PDF 后默认联网补全元数据，仅发送文中的 DOI 或 arXiv 标识；可在 **设置 → 论文库 → 导入设置** 中关闭。
- **配置与备份**：API Key 保存在书库的 `ai-connections.json` 中，界面不回显已保存的 Key。备份前先退出应用，分享书库前移除密钥等私密配置。
- **书库位置**：Windows 安装版默认为 `%APPDATA%\Interleaf\library\`，开发桌面为 `%APPDATA%\Interleaf Dev\library\`；浏览器开发使用项目内的 `.interleaf/`。桌面版可在 **设置 → 论文库 → 书库位置** 迁移整个书库，原目录会保留。

## 开发

```sh
pnpm typecheck     # TypeScript 类型检查
pnpm test          # Go 与前端测试
pnpm build         # 构建处理器、服务、Web、桌面与浏览器扩展
pnpm package       # 在原生 Windows x64 环境生成安装包
```

```text
apps/
├── web/                 React 界面、Readium EPUB 与 PDF.js 阅读引擎
├── desktop/             Electron 主进程与原生能力
├── server/              Go 本地服务、SQLite、AI 与 interleaf 命令行
├── processor/           本地 PDF 版面解析与模型、PDF 导出
└── connector/           浏览器收录扩展
packages/
├── interleaf-core/      文档、定位、批注及共享类型
├── api-client/          OpenAPI 类型与客户端
└── ui/                  shadcn/ui 与 Base UI 组件
docs/                    API 定义与更新说明
website/                 静态官网与界面截图
```

浏览器收录扩展目前需手动加载：运行 `pnpm --filter @interleaf/connector build`，在 Chrome 扩展管理中开启开发者模式，加载 `apps/connector/dist/`。开发环境默认关闭收录连接，需启用时设置 `INTERLEAF_DEV_CONNECTOR=1` 后启动。

维护者发版前需同步根目录与桌面包版本，并更新 [应用内更新说明](docs/release-notes.json)。版本校验与附件生成见 [发布工作流](.github/workflows/release.yml) 和 [Windows 构建工作流](.github/workflows/build.yml)。

## 当前限制

- 没有本地扫描件 OCR；依赖文字层的搜索和翻译无法完整处理纯扫描 PDF。
- EPUB 双语处理暂不支持固定版式、竖排或从右向左阅读的书籍。
- 复杂 PDF 的文字提取、阅读顺序和译文排版仍可能需要人工核对。
- 单文件导入上限为 **512 MB**；导入论文库的 PDF 超过 **100 页或 100 MB** 时需额外确认。
- macOS 与 Linux 安装包不在当前发行流程中；原生安装和跨版本升级仍需平台验收。

## 反馈与致谢

问题与建议请提交 [GitHub Issue](https://github.com/Tazewell/Interleaf/issues)。反馈解析或连接问题时，可附上应用导出的诊断信息，并说明系统版本、文件类型与复现步骤。

感谢 Readium、PDF.js、shadcn/ui、Base UI 及其他依赖项目。模型来源与许可见 [PDF 版面模型说明](apps/processor/model-license/NOTICE.md)，内置字体说明见 [字体文档](apps/processor/fonts/README.md)，UI 组件保留其 [上游许可](packages/ui/LICENSE.md)。
