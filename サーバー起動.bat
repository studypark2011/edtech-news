@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ========================================
echo  EdTech WEEKLY サーバーモードを起動中...
echo ========================================
echo.
echo ブラウザが自動で開きます。期間を変更すると最新のニュースを取得します。
echo 終了するにはこのウィンドウを閉じるか Ctrl+C を押してください。
echo.
node fetch-news.js --serve %*
pause
