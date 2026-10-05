import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { createSecrets, saveSecrets } from './auth.js';
import { atomicWrite, defaultConfig } from './config.js';
import { configPath, secretPath, stateDir } from './paths.js';

if (process.argv[2] !== 'init') {
  console.error('Aufruf: node dist/cli.js init');
  process.exit(2);
}

mkdirSync(stateDir, { recursive: true });
if (!existsSync(configPath)) atomicWrite(configPath, JSON.stringify(defaultConfig, null, 2) + '\n');
if (existsSync(secretPath)) {
  console.log('Ein Administratorpasswort ist bereits eingerichtet.');
} else {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('Administratorpasswort (mindestens 12 Zeichen): ');
    if (stdin.isTTY) execFileSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
    let password: string;
    try { password = await rl.question(''); }
    finally {
      if (stdin.isTTY) { execFileSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] }); stdout.write('\n'); }
    }
    saveSecrets(secretPath, createSecrets(password));
    console.log('Initialisierung abgeschlossen.');
  } finally { rl.close(); }
}
