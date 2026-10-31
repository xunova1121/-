@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 需要先安装 Node.js 18 或更新版本：https://nodejs.org/ & pause & exit /b 1)
node scripts/ensure-build.mjs || (pause & exit /b 1)
echo.
echo 贾维斯网关运行中：浏览器会自动打开；也可以直接双击 jarvis-standalone.html，它会自动连上这个网关。
echo 使用期间请不要关闭本窗口。
start "" http://127.0.0.1:8787
node server/server.mjs
pause
