# Arquitetura de pastas e fluxo das VPS

> Documento vivo. Atualizado após ler os `.bat`/`.js` em [`scripts/`](../scripts/).
> O que ainda falta está marcado com **TODO** (depende de ver a pasta de um bot).

## 1. Visão geral

- 4 VPS Windows, agente roda no usuário `vps` logado.
- Trabalho acontece no **Desktop**. 16 slots (pastas `1..16`), 1 bot por slot.
- Campanha processa números em **ondas de 16 por VPS**.
- **1 campanha por vez por VPS** (trava).

## 2. Layout do Desktop (cada VPS)

```
Desktop\
├── 1\ 2\ ... 16\              <- 16 slots; cada um roda um bot (start-bot.bat)
│   ├── session\                 <- pasta da sessão (após RENOMEAR SESSIONS)
│   └── DADOS\
│       ├── TELEFONES.txt          <- números do slot (após RENOMEAR TELEFONES)
│       ├── TEXTO  (ou TEXTO.txt)  <- mensagem
│       ├── VIDEO\                 <- mídia
│       ├── STATUS.txt             <- (provável saída/estado do bot)  TODO confirmar
│       └── BROADCAST.txt          <- (provável log de envios)        TODO confirmar
├── sessions\                  <- sessions distribuídas no SETUP (a js lê "sessions")
│   └── <telefone>\<numero>-<n>\...   (ex: 5511979947607-1)
├── TELEFONES CAMPANHA\        <- pool de pares TELEFONES-<n>.txt + " - Copia"
├── TELEFONES ERRO\            <- números que falharam vão pra cá
└── neymarlol-scripts\         <- scripts .js + .bat (movimenta/renomear/limpeza)
```

## 3. O que cada script faz (lido do código)

| Ação | Arquivo | Implementação | Observação |
|---|---|---|---|
| MOVIMENTA TELEFONES | `MOVIMENTA TELEFONES.bat` → `neymarlol-scripts/movimenta-numeros.js` | Em `TELEFONES CAMPANHA`, agrupa por `TELEFONES-<n>` exigindo **par** (original + " - Copia"); move os **16 primeiros pares** para `1..16\DADOS\` | par incompleto é ignorado |
| RENOMEAR TELEFONES | `RENOMEAR TELEFONES.bat` (puro .bat, com `pause`) | Em cada `i\DADOS`, renomeia `TELEFONES-*.txt` → `TELEFONES.txt` | original + copia colidem no nome (a 2ª falha) |
| MOVIMENTA SESSIONS | `MOVIMENTA SESSIONS.bat` → `neymarlol-scripts/movimenta-sessions.js` | Em `sessions\<telefone>\<numero>-<n>`, move as **16 primeiras** subpastas `<numero>-<n>` para `1..16\`; apaga pastas de telefone vazias | SETUP |
| RENOMEAR SESSIONS | `RENOMEAR SESSIONS.bat` (puro .bat, com `pause`) | Em cada `i\`, renomeia subpasta que começa com `6*` → `session` | **TODO:** exemplo de número começa com 55, não 6 — confirmar |
| start-all | `start-all.bat` | Loop 1..16: `start "" cmd /k "cd /d Desktop\i && start-bot.bat"` (abre janela por slot; bot fica rodando) | precisa de `start-bot.bat` em cada slot |
| COPIAR VIDEO E TEXTO | `COPIAR VIDEO E TEXTO.bat` | Copia `VIDEO\`, `TEXTO` e `*.txt` de `1\DADOS` para `2..16\DADOS` | prep: configura slot 1 e replica |
| LIMPAR TELEFONES | `LIMPAR TELEFONES.bat` | Deleta `i\DADOS\TELEFONES.txt` (1..16) | reset de números |
| LIMPEZA DADOS | `LIMPEZA DADOS.bat` | Em `2..16\DADOS`: apaga `VIDEO\`, `TEXTO.txt`, `TELEFONES.txt`, `STATUS.txt` | |
| LIMPEZA BROADCAST | `LIMPEZA BROADCAST.bat` → `limpar-broadcast.js` | Esvazia `i\DADOS\BROADCAST.txt` (1..16) | |
| LIMPAR SESSIONS | `LIMPAR SESSIONS.bat` | Apaga `i\session` (1..16) | |

## 4. Fluxo

### SETUP (uma vez)
1. Distribui **sessions** → `Desktop\sessions\<telefone>\<numero>-<n>\...`.
2. `MOVIMENTA SESSIONS` (16 subpastas → slots) → `RENOMEAR SESSIONS` (→ `session`).
3. Prep de conteúdo: coloca `TEXTO`/`VIDEO` em `1\DADOS` → `COPIAR VIDEO E TEXTO`.
4. `start-all` → sobe os 16 bots (ficam rodando).

### CAMPANHA (2–3x/dia) — ondas de 16 por VPS
1. Sobe pares de telefone novos → distribui (par junto) → `Desktop\TELEFONES CAMPANHA\`.
2. **Onda:**
   1. `MOVIMENTA TELEFONES` → 16 pares para `1..16\DADOS\`.
   2. `RENOMEAR TELEFONES` → `TELEFONES.txt` em cada slot.
   3. Bots (já rodando) processam os números do seu `TELEFONES.txt`.  **TODO confirmar como pegam**
   4. **Tratar erros:** mover números com erro para `TELEFONES ERRO`.  **TODO desenhar**
   5. Marcador de fim da onda → próximos 16.  **TODO: qual é o marcador?**
3. Repete até esgotar.

## 5. Integração com o orquestrador (decidido)

- Para automação, rodar as versões **node** (sem `pause`, sem janela), no padrão `neymarlol-scripts`:
  movimenta-numeros / movimenta-sessions já são node. Vou criar equivalentes node sem `pause`
  para **RENOMEAR TELEFONES/SESSIONS** e uma versão de **start-all** orquestrável.
- O agente roda esses scripts via `node ...` capturando stdout (sem raspar janela).
- Distribuição já respeita: **par de telefone junto** e **teto por VPS** (config/distribution.json).

## 6. Pontos em aberto (precisa da pasta de 1 bot — pastas 1..16 são iguais)

- [ ] **Como o bot lê os números:** ele relê `DADOS\TELEFONES.txt` sozinho (watch) ou precisa
      reiniciar a cada onda? (define se a onda chama `start-all` de novo ou não)
- [ ] **STATUS.txt / BROADCAST.txt:** o bot escreve neles? formato? → fonte de progresso/erro.
- [ ] **Erro de número:** onde aparece e quem move para `TELEFONES ERRO` (bot? a gente?).
- [ ] **Marcador de fim da onda:** o que indica "terminou os 16" (ex: `TELEFONES.txt` esvaziou,
      linha no STATUS, contagem no BROADCAST, tempo?).
- [ ] `RENOMEAR SESSIONS` usa `6*` — confirmar padrão real do nome da sessão.
