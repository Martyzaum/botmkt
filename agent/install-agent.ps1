# =====================================================================
#  Instalador do Agente - rodar DENTRO de cada VPS (via RDP), como Admin.
#  (arquivo em ASCII de proposito: Windows PowerShell 5.1 quebra com
#   acentos/traveloss quando o .ps1 nao tem BOM.)
#
#  Esta pasta (agent\) e AUTOSSUFICIENTE: cole ela inteira na VPS (nao
#  precisa git clone). Ela traz o agente (agent.js) E os scripts da
#  campanha (neymarlol-scripts\). O instalador:
#    1) instala/checa o Node
#    2) instala o agente como tarefa que sobe no logon
#    3) copia neymarlol-scripts -> %USERPROFILE%\Desktop\neymarlol-scripts
#  O BOT (slots 1..16 com main.js) e SEU - cole nos Desktops a parte.
#
#  Ex.:  .\install-agent.ps1 -Tenant guilherme -AgentId guilherme-vps01
#
#  IMPORTANTE:
#   - AgentId tem que ser UNICO em toda a frota (use prefixo do tenant).
#   - Tenant = nome do usuario do painel; o orquestrador so manda trabalho
#     do tenant para as VPS daquele tenant.
#   - O agente roda na SESSAO INTERATIVA do usuario (os bots abrem janelas),
#     entao a VPS precisa de AUTO-LOGON (configurado no passo 6).
# =====================================================================
param(
  [string]$HubUrl   = 'https://apibot.atomoz.io',       # API publica do hub (sem barra no fim)
  [string]$HubToken = 'e912fb0a39667bc64e99f57ed1cc90979775a625bee9c677',
  [string]$Tenant   = 'default',                        # tenant desta VPS = nome do usuario do painel (ex.: guilherme)
  [string]$AgentId  = 'default-vps01',                  # UNICO na frota (ex.: guilherme-vps01)
  [string]$InstallDir = 'C:\wppbot-agent',
  [switch]$SetupAutoLogon                               # grava auto-logon do usuario atual (precisa -LogonPassword)
  ,[string]$LogonPassword = ''
  ,[switch]$SkipScripts                                 # NAO copiar neymarlol-scripts pro Desktop
  ,[switch]$DeployIndex                                 # apos copiar os scripts, rodar deploy-index.js (precisa dos slots 1..16 com o bot em main.js)
)

$ErrorActionPreference = 'Stop'
Write-Host "== Instalando agente $AgentId (tenant=$Tenant) ==" -ForegroundColor Cyan

# 1) Node.js presente?
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '== Node nao encontrado. Instalando via winget ==' -ForegroundColor Yellow
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node nao instalou. Instale manualmente de https://nodejs.org e rode de novo.' }
}
Write-Host ("   node: " + (node -v))

# 2) Copia o agent.js para a pasta de instalacao
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'agent.js') -Destination (Join-Path $InstallDir 'agent.js') -Force

# 2b) Copia os scripts da campanha pro Desktop\neymarlol-scripts (o playbook os chama de la)
if (-not $SkipScripts) {
  $scriptsSrc = Join-Path $PSScriptRoot 'neymarlol-scripts'
  $scriptsDst = Join-Path $env:USERPROFILE 'Desktop\neymarlol-scripts'
  if (Test-Path $scriptsSrc) {
    New-Item -ItemType Directory -Force -Path $scriptsDst | Out-Null
    Copy-Item -Path (Join-Path $scriptsSrc '*') -Destination $scriptsDst -Recurse -Force
    Write-Host "   scripts -> $scriptsDst" -ForegroundColor Green
    # opcional: transforma o index.js de cada slot 1..16 no supervisor (precisa do bot em main.js)
    if ($DeployIndex) {
      Write-Host '   deploy-index: index.js <- slot-supervisor.js (backup em index.js.bak)' -ForegroundColor Yellow
      Push-Location $scriptsDst
      try { node 'deploy-index.js' } finally { Pop-Location }
    }
  } else {
    Write-Host "   AVISO: '$scriptsSrc' nao encontrado - cole a pasta 'agent' INTEIRA (com neymarlol-scripts dentro)." -ForegroundColor DarkYellow
  }
}

# 3) Grava a config (lida por um wrapper)
$envFile = Join-Path $InstallDir 'agent.env.ps1'
@"
`$env:HUB_URL    = '$HubUrl'
`$env:HUB_TOKEN  = '$HubToken'
`$env:TENANT_ID  = '$Tenant'
`$env:AGENT_ID   = '$AgentId'
`$env:POLL_MS    = '3000'
`$env:HEARTBEAT_MS = '10000'
"@ | Set-Content -Path $envFile -Encoding UTF8

# 4) Wrapper que carrega a config e sobe o agente
$runner = Join-Path $InstallDir 'run-agent.ps1'
@"
. '$envFile'
Set-Location '$InstallDir'
node '$InstallDir\agent.js'
"@ | Set-Content -Path $runner -Encoding UTF8

# 5) Tarefa agendada: roda NA SESSAO DO USUARIO LOGADO (acesso ao desktop e a apps GUI),
#    sobe no logon e reinicia se cair. Sem limite de tempo de execucao.
$taskName = "wppbot-agent-$AgentId"
$me = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings | Out-Null

# 6) Auto-logon (opcional): garante que apos reboot o usuario loga sozinho e a
#    tarefa "AtLogOn" dispara (os bots precisam de sessao interativa).
if ($SetupAutoLogon) {
  if (-not $LogonPassword) { throw 'Para -SetupAutoLogon, passe -LogonPassword "<senha do usuario>".' }
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $winlogon -Name 'AutoAdminLogon' -Value '1'
  Set-ItemProperty $winlogon -Name 'DefaultUserName' -Value $env:USERNAME
  Set-ItemProperty $winlogon -Name 'DefaultDomainName' -Value $env:USERDOMAIN
  Set-ItemProperty $winlogon -Name 'DefaultPassword' -Value $LogonPassword
  Write-Host '   auto-logon configurado.' -ForegroundColor Green
} else {
  Write-Host '   (auto-logon NAO configurado - rode com -SetupAutoLogon -LogonPassword "..." se a VPS reinicia sem login)' -ForegroundColor DarkYellow
}

# 7) Inicia agora
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State

Write-Host ''
Write-Host "Agente $AgentId (tenant=$Tenant) instalado e rodando." -ForegroundColor Green
if (-not $SkipScripts) { Write-Host "Scripts da campanha em: $env:USERPROFILE\Desktop\neymarlol-scripts" -ForegroundColor Green }
Write-Host ''
Write-Host "Falta o BOT: cole os slots 1..16 (com main.js) no Desktop. Depois, p/ o supervisor:" -ForegroundColor Yellow
Write-Host "  cd `"$env:USERPROFILE\Desktop\neymarlol-scripts`"; node deploy-index.js" -ForegroundColor Yellow
Write-Host ''
Write-Host "Conferir: painel https://bot.atomoz.io (logado como $Tenant) -> Carregar VPS (ONLINE em ~5s)." -ForegroundColor Green
