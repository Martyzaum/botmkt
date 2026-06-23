@echo off
setlocal EnableDelayedExpansion
set DESKTOP=%USERPROFILE%\Desktop

for /L %%i in (2,1,16) do (
    set "PASTA=%DESKTOP%\%%i\DADOS"

    if exist "!PASTA!" (
        echo Processando %%i...

        if exist "!PASTA!\VIDEO" (
            rmdir /s /q "!PASTA!\VIDEO"
        )

        if exist "!PASTA!\TEXTO.txt" (
            del /q "!PASTA!\TEXTO.txt"
        )

        if exist "!PASTA!\TELEFONES.txt" (
            del /q "!PASTA!\TELEFONES.txt"
        )

        if exist "!PASTA!\STATUS.txt" (
            del /q "!PASTA!\STATUS.txt"
        )
    )
)

echo Finalizado.
pause
