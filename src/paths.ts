import { join } from 'node:path';

export const stateDir = process.env.SCREENABLE_STATE_DIR || '/var/lib/screenable-player';
export const runDir = process.env.SCREENABLE_RUN_DIR || '/run/screenable-player';
export const configPath = join(stateDir, 'config.json');
export const secretPath = join(stateDir, 'secrets.json');
export const statusPath = join(runDir, 'status.json');
export const commandPath = join(runDir, 'command.json');
