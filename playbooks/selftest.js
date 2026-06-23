// Playbook de autoteste — usa comandos reais (não depende de C:\bots).
export const meta = { name: 'selftest', description: 'valida o motor de playbooks' };

export default async function ({ run, log, args }) {
  const vps = args.vps || 'LOCALTEST';
  const a = await run(vps, `Write-Output "hostname=$(hostname)"; exit 0`);
  log(`passo1 exit=${a.code} saida=${a.stdout.trim()}`);

  // reage: se exit 0, roda um segundo passo
  if (a.code === 0) {
    const b = await run(vps, `$x = 21*2; Write-Output "calc=$x"`);
    log(`passo2 saida=${b.stdout.trim()}`);
    return { ok: true, host: a.stdout.trim(), calc: b.stdout.trim() };
  }
  return { ok: false };
}
