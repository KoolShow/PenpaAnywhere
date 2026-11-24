# PenpaCanvas

基于 Vite + Vue 3 + TypeScript + WebGL2 的透明透视叠加层，直接复用 `opt-pan/penpa-edit` 原版产物。

## 功能

- **零重写复用 Penpa+**：通过 git submodule `penpa-edit/` 引用 [KoolShow/penpa-edit](https://github.com/KoolShow/penpa-edit)（fork 自 `swaroopg92/penpa-edit`），由 `scripts/sync-penpa.mjs` 从 `penpa-edit/docs` 生成 `public/penpa-edit/`，原版顶部按钮、Mode / Sub / Style 选项、底部控制栏、`#float-key` 与 Modal 全部运行在独立可拖动/缩放/折叠的悬浮窗中，UI 布局完全一致。
- **四点透视 + 混合绘制**：WebGL2 按 4 个透视控制点（2D Homography）将 Penpa+ 题板画布映射到透明叠加层，支持：
  - `正片叠底 (Multiply)`（截图 / 屏幕捕获模式）
  - `Alpha = 1 - 亮度`（透明系统叠加层，白底全透）
  - `去白保色 (1 - minRGB)`（透明系统叠加层保色去白）
  - 控制点对齐切换：`网格四角` / `完整画布`
- **多端运行**：
  - **Windows (Tauri 2)**：无边框透明置顶叠加层，支持题板/工具窗外部区域自动点击穿透及全局快捷键 `Ctrl+Shift+T` 切换穿透锁定。
  - **macOS (Tauri 2)**：启用 `macOSPrivateApi` 实现无边框透明置顶叠加层，通过 CoreGraphics 支持区域自动点击穿透及 `Cmd/Ctrl+Shift+T` 切换穿透锁定。
  - **Android (WebView)**：基于 `TYPE_APPLICATION_OVERLAY` 的全屏透明悬浮 WebView（通知栏提供快捷穿透切换与退出）及应用内截图模式。
  - **Web**：支持 Screen Capture API (`getDisplayMedia`) 与上传/拖拽/粘贴截图模式。

## 常用命令

```bash
# 初始化并同步 Penpa+ submodule（KoolShow/penpa-edit）
git submodule update --init --recursive
pnpm run sync:penpa

# Web 开发与构建
pnpm run dev
pnpm run build

# Windows / macOS (Tauri 2)
pnpm run tauri:dev
pnpm run tauri:build

# macOS 指定架构构建（在 macOS 上执行）
pnpm exec tauri build --target aarch64-apple-darwin
pnpm exec tauri build --target x86_64-apple-darwin
pnpm exec tauri build --target universal-apple-darwin

# Android (同步 dist 至 assets 后编译 APK)
pnpm run android:prepare
cd android && ./gradlew assembleDebug
```

## macOS CI 构建

已配置 [.github/workflows/build-macos.yml](.github/workflows/build-macos.yml)，推送 `v*` tag 或手动触发 `workflow_dispatch` 即可自动构建 Apple Silicon (`aarch64-apple-darwin`) 与 Intel (`x86_64-apple-darwin`) 的 `.app` / `.dmg` 产物。
