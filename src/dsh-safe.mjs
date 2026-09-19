#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const patch = join(root, 'config', 'dsh', 'local-safe.patch.yml');
const dshHome = join(root, 'runtime', 'dsh-home');

await access(dshBin);
await access(patch);

const allowExternalModel = process.env.PET_LEARNING_ALLOW_EXTERNAL_MODEL === '1';
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'read-only',
};

if (!allowExternalModel) {
  delete env.DEEPSEEK_API_KEY;
  delete env.DEEPSEEK_BASE_URL;
}

const args = [dshBin, '--profile', 'headless', '--patch', patch, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  process.stderr.write(`无法启动本地 DSH: ${error.message}\n`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`DSH 被信号 ${signal} 终止\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
