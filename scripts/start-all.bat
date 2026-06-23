@echo off
setlocal enabledelayedexpansion

title START-BOT MANAGER - @_pazterrivel94
color 0A
cls

echo ===================================================
echo.
echo  START-BOT MANAGER - INICIANDO    @_pazterrivel94  
echo.     
echo ===================================================
echo.

REM Caminho fixo para a área de trabalho do usuário 'vps'
set "desktop=%USERPROFILE%\Desktop"

REM Loop de 1 até 16
for /L %%i in (1,1,16) do (
    set "folderPath=%desktop%\%%i"
    set "botPath=!folderPath!\start-bot.bat"

    if exist "!botPath!" (
        echo [%%i] -> Abrindo ^"start-bot.bat^" da pasta %%i... Aguarde...
        start "" cmd /k "cd /d !folderPath! && start-bot.bat"
    ) else (
        color 0C
        echo [%%i] X start-bot.bat NAO encontrado na pasta %%i
        color 0A
    )
    timeout /t 1 >nul
)

echo.
echo ===================================================
echo ->   Todos os bots que existiam foram abertos!   <-
echo ===================================================
echo.
pause
