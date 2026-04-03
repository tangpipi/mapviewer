# Map Viewer

**[Demo](https://www.tangrr.top/mapviewer/)**

一个用于分析 IAR `.map` 文件并生成可视化火焰图报告的工具。

支持三种使用方式：
1. 构建为单一 HTML 工具页（可直接 `file://` 打开）
2. Node.js 脚本生成内嵌数据的单页报告
3. 启动本地/局域网服务进行网页访问

## 环境准备

- Node.js 18+
- pnpm 8+

安装依赖：

```bash
cd frontend
pnpm install
```

## 用法 1：构建单网页工具（`file://` 可用）

该模式生成一个不依赖后端的单文件页面，支持浏览器直接打开。

```bash
cd frontend
pnpm build
```

生成文件：
- `frontend/dist/index.html`

打开方式：
- 双击 `frontend/dist/index.html`
- 或浏览器地址栏输入 `file:///.../frontend/dist/index.html`

使用方法：
- 页面右上角点击上传按钮，选择 `.map` 文件。
- 可在页面中调整合并阈值并 Apply。

## 用法 2：Node.js 脚本生成内嵌报告

该模式会把 map 内容直接注入最终 HTML，生成一个可独立分享的报告文件。

### 2.1 先构建前端模板

```bash
cd frontend
pnpm build
```

### 2.2 生成报告

```bash
cd frontend
pnpm report ..\\your.map
```

默认输出到 map 文件同目录：
- `<map文件名>_report.html`

例如：
- `example1_report.html`

### 可选参数

```bash
pnpm report <map-file> [--gap <value>] [--out <report.html>]
```

- `--gap`, `-g`：可选，注入合并阈值
	- 支持：`64B`、`128`、`1KB`、`1MB`、`0x40`
- `--out`, `-o`：可选，指定输出路径

示例：

```bash
pnpm report ..\\your.map --gap 0x80
pnpm report ..\\your.map -g 1KB -o ..\\reports\\your_custom_report.html
```

### 2.3 外部脚本调用（Python 包装）

仓库根目录提供了 `mapviewer_report.py`，可在任意目录调用。

```bash
py <repo-root>\\mapviewer_report.py <map-file> [output-html] [--gap <value>]
```

示例：

```bash
py .\\mapviewer_report.py .\\your.map
py .\\mapviewer_report.py .\\your.map .\\reports\\your_report.html
py .\\mapviewer_report.py .\\your.map .\\reports\\your_report.html --gap 0x80
```

## 用法 3：启动服务供网络访问

### 3.1 开发模式（热更新，局域网可访问）

```bash
cd frontend
pnpm dev:host
```

默认访问：
- 本机：`http://localhost:5173`
- 局域网：`http://<你的IP>:5173`

### 3.2 预览构建产物（局域网可访问）

```bash
cd frontend
pnpm build
pnpm serve
```

默认访问：
- 本机：`http://localhost:4173`
- 局域网：`http://<你的IP>:4173`

## 常用命令汇总

```bash
# 开发
pnpm dev
pnpm dev:host

# 构建单页
pnpm build

# 构建后预览（可网络访问）
pnpm serve

# 运行测试
pnpm test

# 生成内嵌报告
pnpm report <map-file> [--gap <value>] [--out <file>]
```

## 说明

- 生成报告依赖 `frontend/dist/index.html` 模板，请先执行 `pnpm build`。
- 报告内嵌 map 内容，不依赖外部 map 文件即可查看。
