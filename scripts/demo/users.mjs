// Создаёт (или обновляет) демо-пользователей в Supabase Auth через Admin API.
// Запуск: npm run demo:users  (читает .env.local: NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SECRET_KEY).
// Пароли генерируются случайно и записываются только в supabase/demo/out/demo-accounts.txt
// (папка в .gitignore). В консоль пароли не выводятся.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(import.meta.dirname, '..', '..');
if (existsSync(join(ROOT, '.env.local'))) process.loadEnvFile(join(ROOT, '.env.local'));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('Нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SECRET_KEY в .env.local');
  process.exit(2);
}

const users = JSON.parse(readFileSync(join(ROOT, 'supabase', 'demo', 'users.json'), 'utf8'));
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// Читаемый, но случайный пароль: 4 группы по 4 символа без похожих букв.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
const password = () =>
  Array.from({ length: 4 }, () =>
    Array.from(randomBytes(4), (b) => ALPHABET[b % ALPHABET.length]).join(''),
  ).join('-');

const existing = new Map();
for (let page = 1; ; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  for (const u of data.users) if (u.email) existing.set(u.email.toLowerCase(), u.id);
  if (data.users.length < 200) break;
}

const lines = ['Демо-аккаунты Okuspace (вымышленные люди). НЕ публикуйте этот файл.', ''];
for (const u of users) {
  const pw = password();
  const id = existing.get(u.email);
  const { error } = id
    ? await db.auth.admin.updateUserById(id, { password: pw, email_confirm: true, user_metadata: { full_name: u.name } })
    : await db.auth.admin.createUser({ email: u.email, password: pw, email_confirm: true, user_metadata: { full_name: u.name } });
  if (error) throw new Error(`${u.email}: ${error.message}`);
  console.log(`${id ? 'обновлён' : 'создан  '}  ${u.email}  — ${u.role}`);
  lines.push(`${u.role}`, `  email:  ${u.email}`, `  пароль: ${pw}`, '');
}

const outDir = join(ROOT, 'supabase', 'demo', 'out');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'demo-accounts.txt'), lines.join('\n'), 'utf8');
console.log(`\nГотово: ${users.length} пользователей. Пароли — в supabase/demo/out/demo-accounts.txt`);
