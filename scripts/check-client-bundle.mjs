// Проверяет, что в клиентскую сборку (.next/static) не попали серверные секреты.
// Ищет: (1) имена серверных переменных, (2) характерные префиксы секретов,
// (3) фактические значения серверных переменных из текущего окружения.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STATIC_DIR = '.next/static';
const SERVER_ENV_NAMES = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'PAYMENT_WEBHOOK_SECRET', 'CRON_SECRET', 'RESEND_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'OPENAI_API_KEY', 'DATABASE_URL'];
const SECRET_PATTERNS = [/sb_secret_[A-Za-z0-9_-]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9]{20,}/, /\bsk-ant-[A-Za-z0-9_-]{20,}/, /service_role/];

if (!existsSync(STATIC_DIR)) {
  console.error(`${STATIC_DIR} не найден — сначала выполните npm run build`);
  process.exit(2);
}

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|mjs|json|html|css|map)$/.test(name)) files.push(path);
  }
};
walk(STATIC_DIR);

const values = SERVER_ENV_NAMES.map((n) => process.env[n]).filter((v) => typeof v === 'string' && v.length >= 8);
const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const name of SERVER_ENV_NAMES) if (text.includes(name)) problems.push(`${file}: имя серверной переменной ${name}`);
  for (const re of SECRET_PATTERNS) if (re.test(text)) problems.push(`${file}: совпадение с шаблоном ${re}`);
  for (const v of values) if (text.includes(v)) problems.push(`${file}: значение серверной переменной`);
}

if (problems.length > 0) {
  console.error(`Найдены возможные утечки секретов (${problems.length}):\n` + problems.join('\n'));
  process.exit(1);
}
console.log(`OK: проверено файлов клиентской сборки — ${files.length}, утечек не найдено.`);
