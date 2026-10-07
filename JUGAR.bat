@echo off
cd /d "%~dp0"
start "PixelPark servidor" /b node server.js
timeout /t 1 /nobreak >nul
start "" http://localhost:3000
