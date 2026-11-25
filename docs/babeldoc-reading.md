# BabelDOC 原版式

英文 PDF 可以用 BabelDOC 生成简体中文原版式译文。「对照」和「译文」共用同一份译文 PDF。「对照」单独打开原文，支持同步滚动、独立调宽和切换左右位置。

## 安装与设置

在运行纸间后端的同一操作系统创建独立的 Python 环境。以下 Windows PowerShell 命令使用 `uv` 安装配套版本。

```powershell
$engine = Join-Path $env:LOCALAPPDATA 'Interleaf-BabelDOC'
uv venv --python 3.12 $engine
uv pip install --python (Join-Path $engine 'Scripts\python.exe') pdf2zh-next==2.10.2 babeldoc==0.7.1
$env:INTERLEAF_BABELDOC_EXECUTABLE = Join-Path $engine 'Scripts\pdf2zh_next.exe'
& $env:INTERLEAF_BABELDOC_EXECUTABLE --version
```

从同一个 PowerShell 启动纸间，后端会获取该环境变量。后端也可以从 `PATH` 查找独立环境中的 `pdf2zh_next`。Windows 后端使用 Windows 的 `pdf2zh_next.exe`。WSL 后端可指定 WSL 虚拟环境里 `bin/pdf2zh_next` 的绝对路径。

打开纸间的 AI 设置，保存一个 **OpenAI 兼容**连接并为「翻译」选择具体模型。BabelDOC 用这套配置处理文本。第一次运行会下载版面检测模型和字体。

## 手动验证

1. 导入英文 PDF，打开「对照」，在排版下拉框选择「原版翻译排版」。
2. 阅读区和左上角工具栏会显示同一个生成任务的进度。引擎返回计数时显示百分比，能估算时显示剩余时间。
3. 生成后滚动原文和译文，检查对应页码，再试调宽和左右换边。
4. 切到「译文」检查同一页，然后切回「对照」。原文、翻译设置和引擎未变化时会复用本地译文。
5. 若要停止生成，使用「取消生成」。离开阅读视图后，可回到同一份 PDF 继续查看进度。

BabelDOC 译文可按页查看和选中文字。需要联动原文段落的译文批注、引用跳转和原译文对应定位时，可使用「流式翻译排版」。页数或尺寸无法匹配的产物会提示生成失败。
