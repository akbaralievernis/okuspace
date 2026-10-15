import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Locale } from '@/i18n/config';
import { getPublicEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requiresMfa } from '@/server/authz/check';
import { createPrivilegedClient, createUserClient } from '@/server/supabase/server';
import type { MembershipRecord, SessionUser } from './ports';
import { createSupabaseGateway, createSupabaseRateLimiter, createSupabaseRepository } from './supabase-adapters';
import type { Deps, MemberDeps } from './use-cases';

/** IP клиента за прокси Vercel. Используется только как ключ rate limit (хешируется). */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export async function buildDeps(): Promise<Deps> {
  const client = await createUserClient();
  return {
    gateway: createSupabaseGateway(client),
    limiter: {
      // Привилегированный клиент создаётся лениво: без SUPABASE_SECRET_KEY лимитер «недоступен» → fail closed.
      hit: (...args) => createSupabaseRateLimiter(createPrivilegedClient()).hit(...args),
    },
    logger,
    appUrl: getPublicEnv().NEXT_PUBLIC_APP_URL,
    ip: await clientIp(),
  };
}

export async function buildMemberDeps(user: SessionUser): Promise<MemberDeps> {
  const deps = await buildDeps();
  return { ...deps, repo: createSupabaseRepository(await createUserClient()), user };
}

/** Текущий пользователь (проверен сервером Auth), кешируется на время запроса. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  try {
    return await createSupabaseGateway(await createUserClient()).getUser();
  } catch (error) {
    logger.error('session check failed', { error });
    return null;
  }
});

export interface AccessContext {
  user: SessionUser;
  memberships: MembershipRecord[];
  isPlatformAdmin: boolean;
}

export const getAccessContext = cache(async (user: SessionUser): Promise<AccessContext> => {
  const repo = createSupabaseRepository(await createUserClient());
  const [memberships, isPlatformAdmin] = await Promise.all([repo.myMemberships(user.id), repo.isPlatformAdmin(user.id)]);
  return { user, memberships, isPlatformAdmin };
});

/** Защищённая страница: без сессии → на вход с возвратом обратно. */
export async function requireUser(locale: Locale, returnTo: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/${locale}/login?next=${encodeURIComponent(returnTo)}`);
  return user;
}

/**
 * Защищённая страница рабочего кабинета: привилегированные роли обязаны пройти MFA.
 * БД дополнительно требует aal2 для управления ролями и финансов (миграции 0005–0006).
 */
export async function requireAccess(locale: Locale, returnTo: string): Promise<AccessContext> {
  const user = await requireUser(locale, returnTo);
  const ctx = await getAccessContext(user);
  if (requiresMfa(ctx.memberships, ctx.isPlatformAdmin) && user.aal !== 'aal2') {
    redirect(`/${locale}/mfa?next=${encodeURIComponent(returnTo)}`);
  }
  return ctx;
}
