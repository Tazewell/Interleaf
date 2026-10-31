# 品牌素材

纸间 Interleaf 的标识与应用图标。所有文件由 `scripts/build-brand-assets.mjs` 生成，图形只在该脚本中定义；修改后运行 `node scripts/build-brand-assets.mjs`；使用现有处理器依赖 `@napi-rs/canvas`，支持 macOS、Windows 和 Linux，不需要额外图形工具。不要手工编辑生成结果。

| 路径 | 用途 |
| --- | --- |
| `logo/interleaf-logo.svg`、`logo/interleaf-logo-dark.svg` | 浅色 / 深色圆角方块 logo，README 首图 |
| `logo/interleaf-mark.svg`、`logo/interleaf-mark-light.svg` | 不带底板的标志，分别用于浅色和深色背景 |
| `logo/png/` | 256 / 512 / 1024 px 位图 |
| `icons/macos/icon.icns` | macOS 应用图标（`icon.svg` 为 1024 px 网格源图） |
| `icons/windows/icon.ico` | Windows 应用与安装器图标，16–256 px |

图形以展开的书页和向上翻起的叶形组成，中央留白表现“纸间”。采用林绿底、米白书页与浅绿页片，小尺寸沿用清楚的实心轮廓。官网的 `website/assets/favicon.*` 与 `apple-touch-icon.png` 也由同一脚本生成；GitHub Pages 只发布 `website/`，所以官网使用的图片和截图保留在 `website/assets/`。

应用页面的图标与关于窗口标识位于 `apps/web/public/brand/`，扩展图标和网站内联标识也由同一脚本同步。安装包名称、应用 ID、数据目录、更新源和扩展身份保持稳定。
