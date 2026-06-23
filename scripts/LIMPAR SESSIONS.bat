@echo off
setlocal

echo "================================="
echo.
echo LIMPAR CACHE ( Session )
echo.
echo =================================="

:: Pega o caminho da área de trabalho do usuário atual
set "DESKTOP=%USERPROFILE%\Desktop"

:: Loop de 1 a 16
for /L %%i in (1,1,16) do (
    set "PASTA=%%i"
    call :deleteFolder "%DESKTOP%\%%i\session"
)

echo [OK] Pastas DELETADAS com sucesso!.
pause
exit /b

:deleteFolder
if exist "%~1" (
    echo Deletando: "%~1"
    rmdir /s /q "%~1"
) else (
    echo [ERRO] Pasta não encontrada: "%~1"
)
exit /b
