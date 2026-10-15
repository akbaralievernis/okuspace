// Запуск команды с переменными из env-файла: node scripts/with-env.mjs .env.e2e next build
// (флаг node --env-file не подходит: Next.js передаёт его воркерам через NODE_OPTIONS, где он запрещён).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [file, command, ...args] = process.argv.slice(2);
if (!file || !command) {
  console.error('usage: node scripts/with-env.mjs <env-file> <next|node-bin> [...args]');
  process.exit(2);
}

const env = { ...process.env };
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match && !line.trimStart().startsWith('#')) env[match[1]] ??= match[2];
}

const require = createRequire(import.meta.url);
const bin = command === 'next' ? require.resolve('next/dist/bin/next') : command;
const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
