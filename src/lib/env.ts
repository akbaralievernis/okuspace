import { z } from 'zod';

/** Ошибка конфигурации: перечисляет имена переменных, но никогда не их значения. */
export class EnvError extends Error {
  readonly invalidKeys: string[];

  constructor(scope: string, invalidKeys: string[]) {
    super(`Invalid ${scope} environment variables: ${invalidKeys.join(', ')}. See .env.example.`);
    this.name = 'EnvError';
    this.invalidKeys = invalidKeys;
  }
}

export function parseEnv<T extends z.ZodType>(scope: string, schema: T, source: Record<string, string | undefined>): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
    throw new EnvError(scope, keys);
  }
  return result.data;
}

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

/**
 * Публичные переменные. Обращения к process.env.NEXT_PUBLIC_* записаны явно,
 * чтобы Next.js мог подставить их значения в клиентскую сборку.
 */
export function getPublicEnv(): PublicEnv {
  return parseEnv('public', publicEnvSchema, {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
