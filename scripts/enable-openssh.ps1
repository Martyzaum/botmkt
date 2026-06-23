# =====================================================================
#  Bootstrap OpenSSH Server  —  rodar UMA vez dentro de cada VPS (via RDP)
#  Abra o PowerShell COMO ADMINISTRADOR e cole/execute este script.
# =====================================================================

Write-Host '== 1/5 Instalando OpenSSH Server ==' -ForegroundColor Cyan
$cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
if ($cap.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name $cap.Name
} else {
    Write-Host '   já instalado.'
}

Write-Host '== 2/5 Iniciando e habilitando o serviço sshd ==' -ForegroundColor Cyan
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

Write-Host '== 3/5 Liberando o firewall (porta 22 interna) ==' -ForegroundColor Cyan
if (-not (Get-NetFirewallRule -Name 'sshd-22' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'sshd-22' -DisplayName 'OpenSSH Server (TCP 22)' `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
} else {
    Write-Host '   regra de firewall já existe.'
}

Write-Host '== 4/5 Definindo o PowerShell como shell padrão do SSH ==' -ForegroundColor Cyan
$pwshPath = (Get-Command powershell).Source
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
    -Value $pwshPath -PropertyType String -Force | Out-Null

Write-Host '== 5/5 Verificação ==' -ForegroundColor Cyan
Get-Service sshd | Format-Table Name, Status, StartType -AutoSize
Write-Host ''
Write-Host 'OpenSSH pronto neste VPS. Porta interna: 22' -ForegroundColor Green
Write-Host 'IPs/Adaptadores:' -ForegroundColor Yellow
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object IPAddress, InterfaceAlias

Write-Host ''
Write-Host '>> PRÓXIMO PASSO: no painel do provedor, mapeie uma porta pública -> 22 desta VPS' -ForegroundColor Magenta
Write-Host '>> e coloque essa porta no .env (SSH_PORT_VPSxx) do projeto wppbot.'  -ForegroundColor Magenta
