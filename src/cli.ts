import { existsSync, mkdirSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { createSecrets, minPasswordLength, saveSecrets } from './auth.js';
import { atomicWrite, defaultConfig } from './config.js';
import { configPath, secretPath, stateDir } from './paths.js';

const command = process.argv[2];
if (command !== 'init' && command !== 'passwd') {
  console.error('Aufruf: node dist/cli.js init | passwd');
  process.exit(2);
}

async function hidden(rl: Interface, prompt: string): Promise<string> {
  stdout.write(prompt);
  if (stdin.isTTY) execFileSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
  try { return await rl.question(''); }
  finally {
    if (stdin.isTTY) { execFileSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] }); stdout.write('\n'); }
  }
}

async function setPassword(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const password = await hidden(rl, `Administratorpasswort (mindestens ${minPasswordLength} Zeichen): `);
    if (stdin.isTTY && password !== await hidden(rl, 'Passwort wiederholen: ')) throw new Error('Die Passwörter stimmen nicht überein.');
    saveSecrets(secretPath, createSecrets(password));
  } finally { rl.close(); }
}

try {
  mkdirSync(stateDir, { recursive: true });
  if (command === 'passwd') {
    await setPassword();
    console.log('Passwort geändert. Bestehende Dashboard-Sitzungen sind abgemeldet.');
  } else {
    if (!existsSync(configPath)) atomicWrite(configPath, JSON.stringify(defaultConfig, null, 2) + '\n');
    if (existsSync(secretPath)) console.log('Ein Administratorpasswort ist bereits eingerichtet. Ändern mit: node dist/cli.js passwd');
    else { await setPassword(); console.log('Initialisierung abgeschlossen.'); }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
