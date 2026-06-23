# =====================================================================
#  Instalador do Agente — rodar DENTRO de cada VPS (via RDP), como Admin.
#  Edite as variáveis abaixo (ou passe por parâmetro) antes de rodar.
#
#  Ex.:  .\install-agent.ps1 -Tenant acme -AgentId acme-vps01
#
#  IMPORTANTE:
#   - AgentId tem que ser ÚNICO em toda a frota (use prefixo do tenant).
#   - Tenant agrupa as VPS; o orquestrador só manda trabalho do tenant
#     para as VPS daquele tenant.
#   - O agente roda na SESSÃO INTERATIVA do usuário (os bots abrem janelas),
#     então a VPS precisa de AUTO-LOGON (configurado no passo 6).
# =====================================================================
param(
  [string]$HubUrl   = 'https://bot.atomoz.io',         # URL pública do hub (sem barra no fim)
  [string]$HubToken = '483e87c578a69161bb362c736cf5eaf0a5a25404ff23e98f',
  [string]$Tenant   = 'default',                        # tenant desta VPS
  [string]$AgentId  = 'default-vps01',                  # ÚNICO na frota (ex.: acme-vps01)
  [string]$InstallDir = 'C:\wppbot-agent',
  [switch]$SetupAutoLogon                               # grava auto-logon do usuário atual (precisa -LogonPassword)
  ,[string]$LogonPassword = ''
)

$ErrorActionPreference = 'Stop'
Write-Host "== Instalando agente $AgentId (tenant=$Tenant) ==" -ForegroundColor Cyan

# 1) Node.js presente?
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '== Node não encontrado. Instalando via winget ==' -ForegroundColor Yellow
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node não instalou. Instale manualmente de https://nodejs.org e rode de novo.' }
}
Write-Host ("   node: " + (node -v))

# 2) Copia o agent.js para a pasta de instalação
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'agent.js') -Destination (Join-Path $InstallDir 'agent.js') -Force

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

# 5) Tarefa agendada: roda NA SESSÃO DO USUÁRIO LOGADO (acesso ao desktop e a apps GUI),
#    sobe no logon e reinicia se cair. Sem limite de tempo de execução.
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

# 6) Auto-logon (opcional): garante que após reboot o usuário loga sozinho e a
#    tarefa "AtLogOn" dispara (os bots precisam de sessão interativa).
if ($SetupAutoLogon) {
  if (-not $LogonPassword) { throw 'Para -SetupAutoLogon, passe -LogonPassword "<senha do usuário>".' }
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $winlogon -Name 'AutoAdminLogon' -Value '1'
  Set-ItemProperty $winlogon -Name 'DefaultUserName' -Value $env:USERNAME
  Set-ItemProperty $winlogon -Name 'DefaultDomainName' -Value $env:USERDOMAIN
  Set-ItemProperty $winlogon -Name 'DefaultPassword' -Value $LogonPassword
  Write-Host '   auto-logon configurado.' -ForegroundColor Green
} else {
  Write-Host '   (auto-logon NÃO configurado — rode com -SetupAutoLogon -LogonPassword "..." se a VPS reinicia sem login)' -ForegroundColor DarkYellow
}

# 7) Inicia agora
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State

Write-Host ''
Write-Host "Agente $AgentId (tenant=$Tenant) instalado e rodando." -ForegroundColor Green
Write-Host "No seu PC:  node cli.js agents $Tenant   (deve aparecer ONLINE em alguns segundos)" -ForegroundColor Green
