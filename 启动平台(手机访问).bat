@echo off
chcp 65001 >nul
title 金融信息聚合平台 - 手机可访问模式
setlocal

set "NODE_BIN=C:\Users\huang\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

set "PATH=%USERPROFILE%\.local\bin;%PATH%"
cd /d "%~dp0"

rem 监听所有网卡（默认只监听 127.0.0.1，手机连不上）
set "HOST=0.0.0.0"
set "PORT=8787"

rem 探测本机局域网 IPv4（取第一个非回环、非链路本地地址）
set "LANIP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '26.*' } ^| Select-Object -First 1).IPAddress"`) do set "LANIP=%%i"

echo.
echo  ============================================================
echo    金融信息聚合平台 Finance Hub  ·  手机可访问模式
echo  ============================================================
echo    数据源 : westock CLI (腾讯自选股数据接口)
echo    本机   : http://127.0.0.1:%PORT%
if defined LANIP (
  echo    手机   : http://%LANIP%:%PORT%
) else (
  echo    手机   : 未能探测到局域网地址，请运行 ipconfig 查看 IPv4 地址
)
echo  ------------------------------------------------------------
echo    手机需与本电脑连同一个 Wi-Fi；
echo    首次启动如弹出防火墙提示，请勾选「专用网络」并允许访问。
echo    停止服务：按 Ctrl+C
echo  ============================================================
echo.

start "" "http://127.0.0.1:%PORT%"
"%NODE_BIN%" server.js --port=%PORT%

echo.
echo  服务已停止。
pause
