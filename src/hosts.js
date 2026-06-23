import 'dotenv/config';

const {
  VPS_USER,
  VPS_PASS,
  VPS_IP_PRIMARY,
  VPS_IP_FAILOVER,
  SSH_PORT_VPS01,
  SSH_PORT_VPS02,
  SSH_PORT_VPS03,
  SSH_PORT_VPS04,
} = process.env;

// IPs tentados em ordem (failover). Os dois apontam para o mesmo NAT.
export const IPS = [VPS_IP_PRIMARY, VPS_IP_FAILOVER].filter(Boolean);

export const CREDENTIALS = {
  username: VPS_USER,
  password: VPS_PASS,
};

/**
 * Cada VPS é acessada por uma porta pública diferente (NAT port-mapping).
 * - rdpPort: porta usada hoje para RDP (referência / bootstrap manual).
 * - sshPort: porta pública que será mapeada para o :22 da VPS (automação Node).
 */
export const HOSTS = [
  { name: 'VPS01', rdpPort: 3503, sshPort: Number(SSH_PORT_VPS01) },
  { name: 'VPS02', rdpPort: 3504, sshPort: Number(SSH_PORT_VPS02) },
  { name: 'VPS03', rdpPort: 3507, sshPort: Number(SSH_PORT_VPS03) },
  { name: 'VPS04', rdpPort: 3508, sshPort: Number(SSH_PORT_VPS04) },
];

export function getHost(name) {
  const h = HOSTS.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!h) throw new Error(`Host desconhecido: ${name}. Disponíveis: ${HOSTS.map((x) => x.name).join(', ')}`);
  return h;
}
