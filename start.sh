#!/usr/bin/env bash
# DSH 对话管理工具 —— macOS / Linux 启动脚本
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  没有找到 Node.js，请先安装 Node.js 22.15 或更高版本：https://nodejs.org/"
  echo
  exit 1
fi

echo
echo "  正在启动 DSH 对话管理工具，浏览器会自动打开..."
echo "  按 Ctrl+C 停止服务。"
echo

exec node server.mjs --open
