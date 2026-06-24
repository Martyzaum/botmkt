# =====================================================================
#  VER-LOGS  - abre uma janela por slot acompanhando o log AO VIVO.
#
#  Os logs sao gravados pelo supervisor em Desktop\_logs\slot-<N>.log
#  (grava mesmo rodando escondido pelo agente). Rode isto a QUALQUER
#  momento, inclusive durante a campanha:
#
#     powershell -ExecutionPolicy Bypass -File ver-logs.ps1
#     powershell -ExecutionPolicy Bypass -File ver-logs.ps1 -Slots 4
#
#  Cada janela tem titulo "botlog <slot>" e segue o arquivo (tipo tail -f).
#  O orquestrador chama isto no INICIO da campanha e o fecha-logs.ps1 no FIM.
#  Antes de abrir, fecha as janelas botlog antigas (nao duplica).
# =====================================================================
param([int]$Slots = 16)

# fecha janelas botlog antigas (evita duplicar a cada campanha)
Get-Process powershell -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like 'botlog*' } |
  ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }

$logs = Join-Path $env:USERPROFILE "Desktop\_logs"
New-Item -ItemType Directory -Path $logs -Force | Out-Null

for ($i = 1; $i -le $Slots; $i++) {
  $f = Join-Path $logs ("slot-{0}.log" -f $i)
  if (!(Test-Path $f)) { New-Item -ItemType File -Path $f -Force | Out-Null }
  $cmd = "`$host.ui.RawUI.WindowTitle = 'botlog $i'; Write-Host '== slot $i ==' -ForegroundColor Cyan; Get-Content -LiteralPath '$f' -Wait -Tail 40"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd
}

Write-Host "Abertas $Slots janela(s) 'botlog' seguindo $logs\slot-*.log" -ForegroundColor Green
