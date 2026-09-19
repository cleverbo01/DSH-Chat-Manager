@echo off
chcp 65001 >nul
title 历史对话管理
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，请先安装 Node.js 20 或更高版本。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动历史对话管理，浏览器会自动打开...
echo   关闭这个窗口就等于停止服务。
echo.

node server.mjs --open
pause
