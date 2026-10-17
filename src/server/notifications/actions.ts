'use server';

import { dbState, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';

const PERSON = { mfa: false };
const PATHS = ['/app/notifications'];
const CHANNELS = ['in_app', 'email', 'telegram'] as const;

/** Настройки: флажки `pref:<вид>:<канал>`. Важное в кабинете не выключается (это проверяет и БД). */
export async function savePreferencesAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const db = await createUserClient();
    const { data: kinds, error: kErr } = await db.from('notification_kinds').select('code, optional');
    if (kErr) return dbState(kErr);
    const { data: existing } = await db.from('notification_preferences').select('kind, channel').eq('profile_id', userId);
    const has = new Set((existing ?? []).map((e) => `${e.kind as string}:${e.channel as string}`));
    for (const k of kinds ?? []) {
      for (const channel of CHANNELS) {
        if (channel === 'in_app' && !k.optional) continue;
        const enabled = form.get(`pref:${k.code as string}:${channel}`) === 'on';
        const { error } = has.has(`${k.code as string}:${channel}`)
          ? await db.from('notification_preferences').update({ enabled }).eq('profile_id', userId).eq('kind', k.code).eq('channel', channel)
          : await db.from('notification_preferences').insert({ profile_id: userId, kind: k.code, channel, enabled });
        if (error) return dbState(error);
      }
    }
    return { status: 'success', code: 'saved' };
  }, PERSON);
}

export async function telegramCodeAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const db = await createUserClient();
    const { data, error } = await db.rpc('create_telegram_link_code');
    if (error) return dbState(error);
    return { status: 'success', code: 'telegram_code', data: { code: String(data), bot: process.env.TELEGRAM_BOT_USERNAME ? `@${process.env.TELEGRAM_BOT_USERNAME}` : 'Okuspace' } };
  }, PERSON);
}

export async function unlinkTelegramAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const db = await createUserClient();
    const { error } = await db.from('notification_channels').delete().eq('profile_id', userId).eq('channel', 'telegram');
    return dbState(error);
  }, PERSON);
}
