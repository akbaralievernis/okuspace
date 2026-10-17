// Собирает все миграции в один файл для вставки в Supabase SQL Editor:
// supabase/demo/out/1-migrations.sql (выполняется одним запросом — при ошибке не применится ничего).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const dir = join(ROOT, 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)).sort();

const parts = [`-- Okuspace Next: все миграции (${files.length}) одним файлом. Сгенерировано scripts/demo/bundle-sql.mjs.`];
for (const f of files) parts.push(`\n-- ===== ${f} =====\n`, readFileSync(join(dir, f), 'utf8'));

const outDir = join(ROOT, 'supabase', 'demo', 'out');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, '1-migrations.sql'), parts.join('\n'), 'utf8');
writeFileSync(join(outDir, '2-demo-data.sql'), readFileSync(join(ROOT, 'supabase', 'demo', 'seed.sql'), 'utf8'), 'utf8');
console.log(`Готово: supabase/demo/out/1-migrations.sql (${files.length} миграций) и 2-demo-data.sql`);
