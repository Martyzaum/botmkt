import { NodeSSH } from 'node-ssh';
import { IPS, CREDENTIALS } from './hosts.js';

/**
 * Abre uma conexão SSH para um host, tentando o IP primário e depois o failover.
 * Retorna um NodeSSH conectado + o IP que funcionou.
 */
export async function connect(host, { timeout = 10000 } = {}) {
  const errors = [];
  for (const host_ip of IPS) {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: host_ip,
        port: host.sshPort,
        username: CREDENTIALS.username,
        password: CREDENTIALS.password,
        readyTimeout: timeout,
        // VPS Windows costumam usar keyboard-interactive além de password
        tryKeyboard: true,
        onKeyboardInteractive: (_n, _i, _l, prompts, finish) =>
          finish(prompts.map(() => CREDENTIALS.password)),
      });
      return { ssh, ip: host_ip };
    } catch (err) {
      errors.push(`${host_ip}:${host.sshPort} -> ${err.message}`);
    }
  }
  const e = new Error(`Falha ao conectar em ${host.name}:\n  ${errors.join('\n  ')}`);
  e.attempts = errors;
  throw e;
}

/**
 * Executa um comando em um host (abre, roda, fecha).
 * Por padrão usa PowerShell. Passe { shell: 'cmd' } para cmd.exe.
 */
export async function exec(host, command, { shell = 'powershell' } = {}) {
  const { ssh, ip } = await connect(host);
  try {
    const full =
      shell === 'powershell'
        ? `powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`
        : command;
    const res = await ssh.execCommand(full);
    return { host: host.name, ip, ...res }; // { stdout, stderr, code }
  } finally {
    ssh.dispose();
  }
}
