# =====================================================================
#  FECHA-LOGS - fecha as janelas de log abertas pelo ver-logs.ps1.
#  As janelas tem titulo "botlog <slot>", entao da pra fechar todas de
#  uma vez sem tocar em outras janelas. O orquestrador chama isto no FIM
#  da campanha (e o ver-logs.ps1 tambem chama no comeco, p/ nao duplicar).
#
#     powershell -ExecutionPolicy Bypass -File fecha-logs.ps1
# =====================================================================
$n = 0
Get-Process powershell -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like 'botlog*' } |
  ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $n++ } catch {} }

Write-Host "Janelas de log fechadas: $n"
