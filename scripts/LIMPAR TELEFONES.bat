@echo off
setlocal enabledelayedexpansion

set "desktop=%USERPROFILE%\Desktop"

echo.
echo Deletando arquivos TELEFONES.txt nas subpastas DADOS de 1 a 16...
echo.

REM Salva a cor original
for /f "delims=" %%a in ('"prompt $H & for %%b in (1) do rem"') do set "BS=%%a"

REM Loop de 1 a 16
for /L %%i in (1,1,16) do (
    set "filePath=!desktop!\%%i\DADOS\TELEFONES.txt"
    
    if exist "!filePath!" (
        del /f /q "!filePath!"
        call :colorText 0A "[OK] Arquivo deletado: !filePath!"
    ) else (
        call :colorText 0C "[X] Arquivo não encontrado: !filePath!"
    )
)

call :colorText 0B "Concluído."
echo.
pause
exit /b

REM ========== Função para colorir texto ==========
:colorText
color %1
echo %2
color 07
exit /b
