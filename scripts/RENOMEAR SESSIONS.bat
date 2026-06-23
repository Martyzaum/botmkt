@echo off
setlocal enabledelayedexpansion

color 0A
echo ===================================
echo.
echo Renomear Session - @_pazterrivel94
echo.
echo ===================================

rem Loop de 1 a 16
for /L %%i in (1,1,16) do (
    set "folder=%%i"
    rem Verifica se a pasta existe
    if exist "!folder!\" (
        rem Entra na pasta e procura subpastas que começam com 6
        for /D %%j in ("!folder!\6*") do (
            rem Renomeia a pasta encontrada para "session"
            ren "%%j" "session"
        )
    )
)


echo -> RENOMEADAS COM SUCESSO! <-
pause
