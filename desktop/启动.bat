@echo off
chcp 65001 >nul 2>&1
setlocal
title FutureDream Studio

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found / 未检测到 Node.js
  echo.
  echo   Install it first / 请先安装：
  echo     winget install OpenJS.NodeJS.LTS
  echo   or download from https://nodejs.org  ^(LTS, 18 or newer^)
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 18 (
  echo.
  echo   [X] Node.js is too old / Node.js 版本过低
  echo       need 18+ , found:
  node -v
  echo.
  pause
  exit /b 1
)

echo.
echo   FutureDream Studio / 未来创梦
echo   ---------------------------------------------
echo   Starting local service... / 正在启动本地服务
echo   Close this window to stop. / 关闭此窗口即停止
echo.

rem 浏览器由服务自己拉起：端口被占用时会顺延，写死端口会打开空白页
node core\server.js

echo.
echo   Service stopped. / 服务已停止
pause
