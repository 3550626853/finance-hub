@echo off
chcp 65001 >nul
title 金融信息聚合平台 - 服务端
setlocal

set "NODE_BIN=C:\Users\huang\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

set "PATH=%USERPROFILE%\.local\bin;%PATH%"

cd /d "%~dp0"

echo.
echo  ============================================================
echo    金融信息聚合平台 Finance Hub
echo  ============================================================
echo    数据源 : westock CLI (腾讯自选股数据接口)
echo    地址   : http://127.0.0.1:8787
echo    停止   : 按 Ctrl+C
echo  ============================================================
echo.

"%NODE_BIN%" server.js --port=8787

echo.
echo  服务已停止。
pause
