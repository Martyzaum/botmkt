@echo off
setlocal enabledelayedexpansion

REM Caminho da área de trabalho
set "desktop=%USERPROFILE%\Desktop"

REM Percorre as pastas numeradas de 1 a 16
for /l %%i in (1,1,16) do (
    REM Caminho da pasta DADOS dentro da pasta numerada
    set "pasta=%desktop%\%%i\DADOS"
    
    REM Verifica se a pasta DADOS existe
    if exist "!pasta!" (
        REM Percorre os arquivos na pasta DADOS
        for %%f in ("!pasta!\TELEFONES-*.txt") do (
            REM Pega o nome do arquivo sem a extensão
            set "nome_arquivo=%%~nf"
            
            REM Remove o sufixo numérico após o hífen
            set "nome_arquivo=!nome_arquivo:-*=!"
            
            REM Renomeia o arquivo para "TELEFONES" sem os números
            ren "%%f" "TELEFONES%%~xf"
        )
    )
)

echo Arquivos renomeados com sucesso!
pause
