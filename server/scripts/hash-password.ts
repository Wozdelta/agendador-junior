// Gera o valor de APP_PASSWORD_HASH (scrypt) para o login do acesso remoto.
// Uso: npm run hash-password -w server   (digite a senha; ela não aparece na tela)
import readline from 'node:readline';
import { hashPassword } from '../src/lib/session.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
let muted = false;
out._writeToOutput = (s: string) => {
  if (!muted) process.stdout.write(s);
};
rl.question('Senha de acesso (mín. 12 caracteres): ', (pw) => {
  muted = false;
  process.stdout.write('\n');
  rl.close();
  if (pw.length < 12) {
    console.error('Use pelo menos 12 caracteres.');
    process.exit(1);
  }
  console.log('\nCole no .env do backend:\n');
  console.log(`APP_PASSWORD_HASH=${hashPassword(pw)}`);
});
muted = true;
