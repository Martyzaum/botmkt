# agent — pasta autossuficiente p/ a VPS Windows

Cole **esta pasta inteira** na VPS (não precisa `git clone`). Ela traz tudo que é do
orquestrador; o **bot é seu** e entra à parte.

## O que tem aqui
- `agent.js` — o agente (conecta no hub, recebe jobs, roda os scripts e devolve resultado).
- `install-agent.ps1` — instalador (Node + agente como tarefa no logon + copia os scripts).
- `neymarlol-scripts/` — scripts da campanha (movimenta/renomear/limpa/setup/start-all/
  deploy-index/supervisor). O instalador copia pra `Desktop\neymarlol-scripts`, de onde o
  playbook os chama. **Zero dependência** (só Node nativo, sem `npm install`).

## O que NÃO vem aqui (é seu)
- O **bot**: os slots `Desktop\1 .. Desktop\16`, cada um com o WhatsApp em **`main.js`**
  (+ `node_modules`/config do bot). Cole-os no Desktop. O jeito mais fácil é clonar os
  slots de uma VPS que já roda.

## Passo a passo (por VPS, via RDP como Administrador)

1. Cole a pasta `agent` na VPS (ex.: `C:\wppbot\agent`).
2. Instale o agente + scripts (troque o tenant/id):
   ```powershell
   cd C:\wppbot\agent
   powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -Tenant guilherme -AgentId guilherme-vps01
   ```
   - VPS que reinicia sozinha (recomendado): adicione
     `-SetupAutoLogon -LogonPassword "<senha do Windows>"`.
3. Cole o **bot** nos slots `Desktop\1..16` (cada um com `main.js`).
4. Transforme o `index.js` de cada slot no supervisor (faz backup em `index.js.bak`):
   ```powershell
   cd "$env:USERPROFILE\Desktop\neymarlol-scripts"; node deploy-index.js
   ```
   > Ou passe `-DeployIndex` no instalador **se o bot já estiver nos slots** na hora de instalar.

## Regras
- `-Tenant` = **nome do usuário do painel** (senão a VPS não aparece pra ele).
- `-AgentId` = **único na frota** (`guilherme-vps01`, `guilherme-vps02`, …).
- O supervisor roda `node main.js` e detecta o fim da onda pelos logs
  `ENVIO DA BROADCAST TERMINADO` / `NENHUM NÚMERO RESTANTE.` — o bot precisa imprimir isso.

## Conferir
Painel `https://bot.atomoz.io` (logado como o tenant) → **Carregar VPS** (ONLINE em ~5s),
ou no seu PC: `node cli.js agents <tenant>`.
