import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { getPublicEnv } from '@/lib/env';
import { getServerEnv } from '@/server/env';

/**
 * Клиент от имени текущего пользователя (JWT из cookie). Все обычные запросы — через него,
 * чтобы RLS применялся к каждому запросу.
 */
export async function createUserClient(): Promise<SupabaseClient> {
  const env = getPublicEnv();
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Вызов из Server Component: cookie нельзя записать — сессию обновит proxy (этап 3).
        }
      },
    },
  });
}

/**
 * Клиент с секретным ключом — ОБХОДИТ RLS. Только для фоновых задач, webhook'ов и
 * администрирования платформы; каждое использование должно журналироваться (этап 2).
 */
export function createPrivilegedClient(): SupabaseClient {
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { SUPABASE_SECRET_KEY } = getServerEnv();
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
