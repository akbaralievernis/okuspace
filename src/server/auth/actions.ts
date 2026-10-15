'use server';

import { redirect, unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { logger } from '@/lib/logger';
import { getCurrentUser, buildDeps, buildMemberDeps } from './session';
import * as uc from './use-cases';
import type { FormState, Outcome } from './use-cases';

function localeOf(form: FormData): Locale {
  const value = form.get('locale');
  return isLocale(value) ? value : defaultLocale;
}

function settle(outcome: Outcome): FormState {
  if (outcome.kind === 'redirect') redirect(outcome.to);
  return outcome.state;
}

/** Конфигурация сервера неполна (нет env) — сообщаем «недоступно», детали только в лог. */
async function guarded(fn: () => Promise<FormState>): Promise<FormState> {
  try {
    return await fn();
  } catch (error) {
    // redirect()/notFound() реализованы через исключения — их нужно пробросить.
    unstable_rethrow(error);
    logger.error('auth action failed', { error });
    return { status: 'error', code: 'unavailable' };
  }
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => settle(await uc.login(form, localeOf(form), await buildDeps())));
}

export async function registerAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => settle(await uc.register(form, localeOf(form), await buildDeps())));
}

export async function forgotPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => settle(await uc.requestPasswordReset(form, localeOf(form), await buildDeps())));
}

export async function resetPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => settle(await uc.resetPassword(form, await buildDeps())));
}

export async function verifyMfaAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => settle(await uc.verifyMfa(form, localeOf(form), await buildDeps())));
}

export async function signOutOthersAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => {
    const result = settle(await uc.signOutOthers(await buildDeps()));
    revalidatePath(`/${localeOf(form)}/app/account`);
    return result;
  });
}

export async function logoutAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  try {
    const deps = await buildDeps();
    await deps.gateway.signOut('local');
  } catch (error) {
    logger.error('logout failed', { error });
  }
  redirect(`/${locale}/login`);
}

export async function inviteMemberAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => {
    const user = await getCurrentUser();
    if (!user) return { status: 'error', code: 'session_expired' };
    const locale = localeOf(form);
    const result = settle(await uc.inviteMember(form, locale, await buildMemberDeps(user)));
    revalidatePath(`/${locale}/app/members`);
    return result;
  });
}

export async function setMembershipStatusAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => {
    const user = await getCurrentUser();
    if (!user) return { status: 'error', code: 'session_expired' };
    const result = settle(await uc.setMembershipStatus(form, await buildMemberDeps(user)));
    revalidatePath(`/${localeOf(form)}/app/members`);
    return result;
  });
}

export async function acceptInvitationAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async () => {
    const user = await getCurrentUser();
    if (!user) return { status: 'error', code: 'session_expired' };
    const token = form.get('token');
    return settle(await uc.acceptInvitation(typeof token === 'string' ? token : '', localeOf(form), await buildMemberDeps(user)));
  });
}

export async function enrollMfaAction(): Promise<{ ok: true; factorId: string; qrCode: string; secret: string } | { ok: false; code: uc.FormErrorCode }> {
  try {
    return await uc.enrollMfa(await buildDeps());
  } catch (error) {
    logger.error('mfa enroll failed', { error });
    return { ok: false, code: 'unavailable' };
  }
}
