@echo off
rem ============================================================
rem  AionAdmin 永恒之塔管理后台
rem  直连 CacheD 管理端口(2007) 与游戏数据库，替代 AionWeb + GMServer
rem ============================================================
cd /d "%~dp0"
title AionAdmin 管理后台 http://127.0.0.1:8088
where node >nul 2>nul || (echo [!] 没有找到 Node.js，请先安装：winget install OpenJS.NodeJS.LTS & pause & exit /b)
if not exist node_modules\mssql (
  echo 首次运行，正在安装依赖 mssql ...
  call npm install --omit=dev || (echo [!] 依赖安装失败 & pause & exit /b)
)
echo.
echo   浏览器打开 http://127.0.0.1:8088/  （只允许本机访问）
echo   首次使用会要求设置管理密码。关闭本窗口即停止后台。
echo.
start "" http://127.0.0.1:8088/
node server\main.ts
echo.
echo   [!] 后台已停止。
pause
