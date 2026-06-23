# wppbot — Automação de VPS Windows via SSH (Node.js)

Infraestrutura para automatizar comandos CLI/PowerShell em 4 VPS Windows.

## Diagnóstico da rede (feito em 2026-06-23)

- 4 VPS atrás de **NAT/port-mapping** num único IP público.
- IP primário: `177.19.232.229` · IP failover: `38.210.109.80` (apontam pro mesmo NAT).
- Portas **RDP** confirmadas (NLA/CredSSP): `3503`, `3504`, `3507`, `3508`.
- **Nenhuma porta SSH/WinRM exposta** ainda. SSH precisa ser habilitado + mapeado.

| Apelido | RDP (hoje) | SSH (a mapear) |
|---------|-----------|----------------|
| VPS01   | 3503      | `SSH_PORT_VPS01` |
| VPS02   | 3504      | `SSH_PORT_VPS02` |
| VPS03   | 3507      | `SSH_PORT_VPS03` |
| VPS04   | 3508      | `SSH_PORT_VPS04` |

## Setup

### 1. Instalar dependências
```bash
npm install
```

### 2. Habilitar SSH em cada VPS (uma vez, via RDP)
Conecte por RDP em cada VPS (mstsc → `177.19.232.229:3503`, usuário `vps`),
abra o **PowerShell como Administrador** e rode [`scripts/enable-openssh.ps1`](scripts/enable-openssh.ps1).

### 3. Mapear porta pública → 22 (painel do provedor)
Cada VPS já tem uma porta pública para RDP. Peça/configure no painel uma porta
pública apontando para o `:22` interno de cada VPS. Anote as portas no `.env`
(`SSH_PORT_VPS01..04`).

> Sem esse mapeamento o Node não alcança o SSH — só a porta RDP está aberta no NAT.

### 4. Configurar credenciais
```bash
cp .env.example .env   # já existe um .env preenchido; ajuste as portas SSH
```

### 5. Testar
```bash
npm run test:conn
```

## Uso

```bash
# Um host
node src/runCommand.js VPS01 "Get-Date"

# Todos em paralelo
node src/runCommand.js all "Get-Process | Measure-Object | % Count"
```

## Arquitetura

Dois caminhos. Como hoje **só o RDP está exposto** (sem porta de comando no NAT),
a abordagem em uso é a **B (agente outbound)**.

### Opção B — Agente Node (EM USO)

Não precisa abrir porta no NAT: o agente roda dentro da VPS e conecta **para fora**
no hub, busca comandos, executa em PowerShell e devolve o resultado.

```
você ──CLI──▶ HUB (público) ◀──poll/outbound── agente (dentro da VPS)
```

- [`hub/server.js`](hub/server.js) — hub de controle (fila + resultados). Zero deps.
- [`agent/agent.js`](agent/agent.js) — agente que roda na VPS. Zero deps.
- [`agent/install-agent.ps1`](agent/install-agent.ps1) — instala Node + agente como tarefa no boot.
- [`cli.js`](cli.js) — envia comandos e lê resultados.

Fluxo:
1. **Hospedar o hub** num lugar com URL pública (cloud barato, ou túnel Cloudflare/ngrok
   apontando pra esta máquina). Defina `HUB_TOKEN` e `HUB_PORT` no `.env`.
   ```bash
   npm run hub
   ```
2. **Em cada VPS (via RDP)**: editar as variáveis no topo de `agent/install-agent.ps1`
   (`HubUrl`, `AgentId` = VPS01..04) e rodar como Admin.
3. **No seu PC**: apontar `HUB_URL` no `.env` pra URL pública do hub e usar:
   ```bash
   node cli.js agents
   node cli.js run VPS01 "Get-Date"
   node cli.js run all   "Get-Process | Measure-Object | % Count"
   ```

### Playbooks (lógica centralizada no hub)

Para "rodar script em caminho específico → ler resultado → reagir", escreva um
playbook em [`playbooks/`](playbooks/). Ele roda no hub, com `if/else`, regex,
exit code etc. Veja o template [`playbooks/exemplo.js`](playbooks/exemplo.js).

```bash
node cli.js playbooks            # lista
node cli.js play exemplo         # roda e acompanha o log ao vivo
node cli.js play exemplo '{"vps":"VPS02"}'
node cli.js runs                 # histórico
node cli.js runlog <runId>       # log de uma execução
```

API dentro do playbook: `run(agent, comando, opts?)` (espera o resultado),
`runAll(comando)`, `log(msg)`, `args`, `agents()`. Editar um `.js` em `playbooks/`
NÃO exige reiniciar o hub (recarrega a cada execução).

### Opção A — SSH direto (em espera)

Precisa de 1 regra de NAT (porta pública → :22 da VPS), que hoje não temos acesso.
Fica pronta caso surja acesso ao roteador.

- [`src/hosts.js`](src/hosts.js) — inventário dos hosts + IPs com failover.
- [`src/sshClient.js`](src/sshClient.js) — conexão SSH (tenta primário→failover) e `exec()`.
- [`src/testConnections.js`](src/testConnections.js) — checa TCP + login SSH de cada VPS.
- [`src/runCommand.js`](src/runCommand.js) — roda um comando num host ou em todos.
