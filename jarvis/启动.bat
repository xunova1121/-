@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 需要先安装 Node.js 18 或更新版本：https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules (echo 首次运行，正在安装依赖…… & call npm install || (pause & exit /b 1))
if not exist dist (call npm run build || (pause & exit /b 1))
start "" http://127.0.0.1:8787
node server/server.mjs
pause
