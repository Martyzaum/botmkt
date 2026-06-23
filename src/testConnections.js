import net from 'node:net';
import { HOSTS, IPS, CREDENTIALS } from './hosts.js';
import { connect } from './sshClient.js';

function tcpCheck(host_ip, port, timeout = 2500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host_ip);
  });
}

async function main() {
  console.log('=== Teste de conexões VPS ===');
  console.log(`Usuário: ${CREDENTIALS.username}  |  IPs: ${IPS.join(' , ')}\n`);

  for (const host of HOSTS) {
    process.stdout.write(`▸ ${host.name} (ssh ${host.sshPort}, rdp ${host.rdpPort})\n`);

    // 1) TCP reachability nas duas rotas
    for (const ip of IPS) {
      const ok = await tcpCheck(ip, host.sshPort);
      console.log(`    TCP ${ip}:${host.sshPort}  ${ok ? '✅ aberta' : '❌ fechada'}`);
    }

    // 2) Handshake SSH real (login)
    try {
      const { ssh, ip } = await connect(host, { timeout: 8000 });
      const res = await ssh.execCommand('hostname');
      console.log(`    SSH  ✅ login OK via ${ip} — hostname: ${res.stdout.trim()}`);
      ssh.dispose();
    } catch (err) {
      console.log(`    SSH  ❌ ${err.message.split('\n')[0]}`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
