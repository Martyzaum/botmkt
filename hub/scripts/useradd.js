// =====================================================================
//  Gerencia usuários do login do hub (grava no SQLite do volume).
//
//  Como o banco fica no volume do container, rode via docker exec:
//    docker exec botmkt node --experimental-sqlite hub/scripts/useradd.js add <user> <senha> <tenant> [admin]
//    docker exec botmkt node --experimental-sqlite hub/scripts/useradd.js list
//    docker exec botmkt node --experimental-sqlite hub/scripts/useradd.js del  <user>
// =====================================================================
import { addUser, listUsers, deleteUser } from '../lib/auth.js';

const [cmd, a, b, c, d] = process.argv.slice(2);

function usage() {
  console.log('uso:');
  console.log('  add <user> <senha> <tenant> [admin]');
  console.log('  list');
  console.log('  del <user>');
  process.exit(1);
}

if (cmd === 'list') {
  const users = listUsers();
  if (!users.length) console.log('(nenhum usuário)');
  else console.table(users);
} else if (cmd === 'add') {
  if (!a || !b || !c) usage();
  const u = addUser({ username: a, password: b, tenant: c, role: d === 'admin' ? 'admin' : 'user' });
  console.log('ok:', u);
} else if (cmd === 'del') {
  if (!a) usage();
  console.log(deleteUser(a));
} else {
  usage();
}
