# <img src="docs/images/icon.png" width="36" height="36" align="absmiddle" alt="PenpaAnywhere" /> PenpaAnywhere

English | [简体中文](README.zh-CN.md)

Use [Penpa+](https://github.com/swaroopg92/penpa-edit) in a floating overlay on Windows, macOS, Android, and Web.

![PenpaAnywhere](docs/images/cover-01-hero-multiplatform.png)

## Features

- Transparent overlay over windows, images, and screen capture
- Perspective alignment for tilted or skewed puzzles
- Blend modes and click-through
- Dynamic theming and custom CSS
- Auto-save progress and settings
- i18n support

## Showcase

| Perspective Alignment | Desktop Overlay |
| :---: | :---: |
| ![Perspective Alignment](docs/images/cover-02-perspective-homography.png) | ![Desktop Overlay](docs/images/cover-03-desktop-overlay.png) |

## Quick Start

```bash
git submodule update --init --recursive
pnpm install
pnpm run sync:penpa

# Web
pnpm run dev
pnpm run build

# Windows / macOS
pnpm run tauri:dev
pnpm run tauri:build

# Android
pnpm run android:prepare
cd android && ./gradlew assembleDebug
```

## License

[MIT License](LICENSE)
