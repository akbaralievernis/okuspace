import { createBrowserClient } from '@supabase/ssr';
import { getPublicEnv } from '@/lib/env';

/** Браузерный клиент: только публичный ключ, доступ ограничен RLS. */
export function createBrowserSupabase() {
  const env = getPublicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
