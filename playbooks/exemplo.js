// =====================================================================
//  Playbook de exemplo — copie e adapte com seus caminhos reais.
//  Roda no HUB (centralizado). Aciona com:
//     node cli.js play exemplo                       (sem args)
//     node cli.js play exemplo '{"vps":"VPS02"}'     (com args)
//
//  API disponível no contexto (ctx):
//    run(agent, comando, opts?)  -> executa e ESPERA: { agent, stdout, stderr, code }
//    runAll(comando, opts?)      -> roda em todos os agentes, retorna array
//    log(msg)                    -> grava no log da execução (visível no painel)
//    args                        -> objeto passado no acionamento
//    agents()                    -> lista de agentes conhecidos
//
//  opts: { shell: 'powershell' | 'cmd', timeoutMs }
// =====================================================================

export const meta = {
  name: 'exemplo',
  description: 'Roda um script, lê o resultado e reage conforme a saída/exit code',
};

export default async function ({ run, log, args }) {
  const vps = args.vps || 'VPS01';

  // 1) Roda um script num caminho específico da VPS e captura o resultado
  log(`checando ${vps}`);
  const check = await run(vps, `& 'C:\\bots\\check.ps1'`);

  // 2) "Reage" com base no exit code e/ou no conteúdo da saída
  const falhou = check.code !== 0 || /erro|offline|down/i.test(check.stdout);

  if (falhou) {
    log(`check falhou (exit=${check.code}). Saída: ${check.stdout.trim().slice(0, 200)}`);
    log('executando recuperação...');
    const fix = await run(vps, `& 'C:\\bots\\restart.ps1'`);
    log(`restart exit=${fix.code}`);

    // 3) Confere de novo depois de reagir
    const recheck = await run(vps, `& 'C:\\bots\\check.ps1'`);
    if (recheck.code === 0) {
      log('✔ recuperado com sucesso');
      return { vps, recuperado: true };
    }
    log('✖ ainda com problema após restart');
    return { vps, recuperado: false, saida: recheck.stdout };
  }

  log(`✔ ${vps} ok: ${check.stdout.trim()}`);
  return { vps, ok: true };
}
