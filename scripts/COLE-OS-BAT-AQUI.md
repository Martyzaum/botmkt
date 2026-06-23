# Cole aqui os .bat das VPS

Cole os arquivos `.bat` reais (exatamente como estão nas VPS) nesta pasta.
Pode manter os nomes originais. Prioridade para o fluxo da campanha:

- `start-all.bat`
- `MOVIMENTA TELEFONES.bat`
- `RENOMEAR TELEFONES.bat`
- `MOVIMENTA SESSIONS.bat`
- `RENOMEAR SESSIONS.bat`

Se houver um script que cada pasta `1..16` executa (o bot em si), cole também.

Depois que colar, eu leio, preencho [`docs/ARQUITETURA-PASTAS.md`](../docs/ARQUITETURA-PASTAS.md)
e desenho o motor de ondas em cima do real.

> Nesta pasta também já existe o `enable-openssh.ps1` (setup de SSH, não usado no
> fluxo atual). O `install-agent.ps1` fica em `agent/`. O resto aqui são os `.bat`.
