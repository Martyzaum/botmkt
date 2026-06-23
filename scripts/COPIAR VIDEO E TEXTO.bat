@echo off
setlocal EnableDelayedExpansion

set DESKTOP=%USERPROFILE%\Desktop
set ORIGEM=%DESKTOP%\1\DADOS

for /L %%i in (2,1,16) do (
    set DESTINO=%DESKTOP%\%%i\DADOS

    if exist "!DESTINO!" (
        echo Copiando para pasta %%i...

        rem Copia a pasta VIDEO
        if exist "%ORIGEM%\VIDEO" (
            xcopy "%ORIGEM%\VIDEO" "!DESTINO!\VIDEO" /E /I /Y >nul
        )

        rem Copia o arquivo TEXTO (caso exista sem extensao)
        if exist "%ORIGEM%\TEXTO" (
            copy "%ORIGEM%\TEXTO" "!DESTINO!\" /Y >nul
        )

        rem Copia todos os arquivos .txt
        copy "%ORIGEM%\*.txt" "!DESTINO!\" /Y >nul

    ) else (
        echo Pasta DADOS nao encontrada em %%i
    )
)

echo.
echo Processo concluid
