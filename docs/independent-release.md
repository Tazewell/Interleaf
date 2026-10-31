# Interleaf 首次发布

当前独立仓库为 `Tazewell/Interleaf`，应用名 Interleaf，应用 ID `io.github.tazewell.interleaf`，链接协议 `interleaf://`。

## 首次准备

1. 在 GitHub 创建 `Tazewell/Interleaf` 仓库。公开仓库的 Releases 可供普通用户下载。
2. 本地 origin 已改为 `https://github.com/Tazewell/Interleaf.git`。完成检查后，将 main 推送到该仓库并启用 Actions。
3. 当前流水线同时构建 Windows x64 和 Apple Silicon macOS；macOS 正式构建需要仓库 secrets `MAC_SIGN_P12` 和 `MAC_SIGN_P12_PASSWORD`。按 releasing.md 生成属于 Interleaf 的固定证书并离线备份。任一平台失败都会阻止统一上传。
4. 更新两个 package.json 的版本和 docs/release-notes.json，保持一致。当前源码版本为 0.8.7，版本号可在首次发行前决定，后续必须递增。
5. 先手动运行 Release installers 取得测试安装包；验证安装、导入、笔记保存及退出。手动运行不会公开发布。
6. 检查通过后，创建对应 tag（例如版本为 0.8.8 时使用 v0.8.8），在 GitHub 发布该 Release。工作流会上传 Interleaf 安装包和最后生成的 SHA256SUMS.txt。

下载入口：<https://github.com/Tazewell/Interleaf/releases/latest>。网站下载按钮、反馈入口和应用更新均指向此仓库。GitHub Pages 网站源码在 website；启用 Pages 后预期地址为 <https://tazewell.github.io/Interleaf/>。

## 用户更新

已安装的 Interleaf 每日检查正式版，也可在关于窗口手动检查。Windows 用户确认后会下载、校验、保存阅读数据、退出并运行安装程序；macOS 固定签名和更新 ZIP 可用时支持原地更新，否则使用 DMG。

应用用户数据使用 Interleaf 目录；开发桌面使用 Interleaf Dev。不会自动搬移或删除其他应用的书库。内部 CLI 仍名为 reader，通过新的 Interleaf 数据目录发现本机服务；内部工作区包名、数据库格式及 API 通信头保持兼容。

首次上线前需要用两个真实安装版本验收：安装较低版本并创建测试批注，再发布较高版本，在旧版检查更新，确认重启后版本变更、书库和批注保留。开发网页不执行应用内更新。

本次配置修改未创建远程仓库、推送代码、发布 Release、生成证书或验证真实安装升级。

浏览器扩展使用独立端口 17842 和新开发身份。Chrome Web Store 尚未发布；上架前须配置自己的商店 ID，不能沿用其他应用的商店信息。

## 本次验证（2026-10-31）

- 类型检查、Go 后端完整测试通过。
- 16 个相关 JavaScript 测试文件共 156 项通过；一次工作线程启动超时后单独重跑通过。
- Web、Electron 主进程、处理器和浏览器扩展生产构建通过。
- 当前跟踪文件未检出原仓库 owner、旧扩展公钥/ID 或旧签名名称。
- 尚未创建/推送远程仓库、公开 Release 或生成 Windows/macOS 安装包；真实首次安装、系统签名提示和跨版本更新仍需原生平台人工验收。
