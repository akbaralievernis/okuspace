import 'server-only';

import { z } from 'zod';
import { logLevels } from '@/lib/logger';
import { parseEnv } from '@/lib/env';

export const serverEnvSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(20),
  LOG_LEVEL: z.enum(logLevels).default('info'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Серверные секреты. Проверяются при первом обращении, чтобы сборка не требовала production-ключей. */
export function getServerEnv(): ServerEnv {
  cached ??= parseEnv('server', serverEnvSchema, {
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    LOG_LEVEL: process.env.LOG_LEVEL,
  });
  return cached;
}

export const siteConfigSchema = z.object({
  SITE_ORGANIZATION_SLUG: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(63),
});

/** Какую школу показывает публичный сайт (slug из public.organizations). Не секрет, но и не нужен браузеру. */
export function getSiteConfig(): z.infer<typeof siteConfigSchema> {
  return parseEnv('site', siteConfigSchema, { SITE_ORGANIZATION_SLUG: process.env.SITE_ORGANIZATION_SLUG });
}
