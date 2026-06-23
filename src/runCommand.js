import { HOSTS, getHost } from './hosts.js';
import { exec } from './sshClient.js';

/**
 * Uso:
 *   node src/runCommand.js <VPS01|all> "<comando powershell>"
 * Exemplos:
 *   node src/runCommand.js VPS01 "Get-Date"
 *   node src/runCommand.js all   "Get-Process | Measure-Object | % Count"
 */
async function main() {
  const [, , target, ...rest] = process.argv;
  const command = rest.join(' ');
  if (!target || !command) {
    console.error('Uso: node src/runCommand.js <VPS01|all> "<comando>"');
    process.exit(1);
  }

  const hosts = target.toLowerCase() === 'all' ? HOSTS : [getHost(target)];

  const results = await Promise.allSettled(
    hosts.map((h) => exec(h, command)),
  );

  results.forEach((r, i) => {
    const name = hosts[i].name;
    if (r.status === 'fulfilled') {
      const { ip, stdout, stderr, code } = r.value;
      console.log(`\n===== ${name} (${ip}) exit=${code} =====`);
      if (stdout) console.log(stdout.trimEnd());
      if (stderr) console.error('[stderr] ' + stderr.trimEnd());
    } else {
      console.log(`\n===== ${name} FALHOU =====`);
      console.error(r.reason.message);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
