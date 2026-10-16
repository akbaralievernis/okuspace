'use server';

import { z } from 'zod';
import { dbState, parseForm, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';
import { newDeviceToken } from './device';

/** Настройки, устройства и решения по предупреждениям — сотрудники с MFA; права проверяет БД. */
const STAFF = { mfa: true };
const PATHS = ['/app/monitoring', '/app'];
const uuid = z.uuid();
const blank = (v: unknown) => (v === '' ? undefined : v);
const checkbox = z.preprocess((v) => v === 'on' || v === 'true', z.boolean());
const text = (min: number, max: number) => z.preprocess(blank, z.string().trim().min(min, { message: 'body_too_short' }).max(max, { message: 'message_too_long' }).optional());

const PolicySchema = z.object({
  organizationId: uuid,
  enabled: checkbox,
  purpose: text(10, 1000),
  legalBasis: text(10, 1000),
  noticeText: text(20, 4000),
  publishNotice: checkbox,
  legalReviewer: text(3, 200),
  legalReviewed: checkbox,
  dataRetentionDays: z.coerce.number().int().min(1, { message: 'count_invalid' }).max(90, { message: 'count_invalid' }),
  alertRetentionDays: z.coerce.number().int().min(30, { message: 'count_invalid' }).max(365, { message: 'count_invalid' }),
});

export async function savePolicyAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(PolicySchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { data: current } = await db.from('monitoring_policies').select('notice_published_at, legal_reviewed_at').eq('organization_id', v.organizationId).maybeSingle();
    const now = new Date().toISOString();
    const { data, error } = await db
      .from('monitoring_policies')
      .upsert({
        organization_id: v.organizationId,
        enabled: v.enabled,
        purpose: v.purpose ?? null,
        legal_basis: v.legalBasis ?? null,
        notice_text: v.noticeText ?? null,
        // Отметки ставятся сервером в момент подтверждения; снятие флажка снимает отметку.
        notice_published_at: v.publishNotice ? ((current?.notice_published_at as string | null) ?? now) : null,
        legal_reviewer: v.legalReviewer ?? null,
        legal_reviewed_at: v.legalReviewed ? ((current?.legal_reviewed_at as string | null) ?? now) : null,
        data_retention_days: v.dataRetentionDays,
        alert_retention_days: v.alertRetentionDays,
        updated_by: userId,
      })
      .select('organization_id');
    if (error?.message?.includes('monitoring_policies_enable_check')) return { status: 'error', code: 'validation', fieldErrors: { enabled: ['consent_required'] } };
    return dbState(error, data);
  }, STAFF);
}

const DeviceSchema = z.object({
  organizationId: uuid,
  branchId: uuid,
  classroomId: z.preprocess(blank, uuid.optional()),
  name: z.string().trim().min(1, { message: 'title_required' }).max(100, { message: 'title_required' }),
  kind: z.enum(['occupancy_counter', 'entrance_counter']),
});

export async function addDeviceAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(DeviceSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const { token, hash } = newDeviceToken();
    const db = await createUserClient();
    const { data, error } = await db
      .from('camera_devices')
      .insert({ organization_id: v.organizationId, branch_id: v.branchId, classroom_id: v.classroomId ?? null, name: v.name, kind: v.kind, token_sha256: hash, created_by: userId })
      .select('id')
      .single();
    if (error) return dbState(error);
    // Токен показывается один раз и нигде не сохраняется в открытом виде.
    return { status: 'success', code: 'device_created', data: { secret: `${data.id as string}.${token}` } };
  }, STAFF);
}

export async function rotateDeviceTokenAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ deviceId: uuid }), form);
    if (!r.ok) return r.state;
    const { token, hash } = newDeviceToken();
    const db = await createUserClient();
    const { data, error } = await db.from('camera_devices').update({ token_sha256: hash }).eq('id', r.data.deviceId).select('id');
    if (error || !data?.length) return dbState(error, data);
    return { status: 'success', code: 'device_created', data: { secret: `${r.data.deviceId}.${token}` } };
  }, STAFF);
}

export async function updateDeviceAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ deviceId: uuid, status: z.enum(['active', 'disabled']), classroomId: z.preprocess(blank, uuid.optional()) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('camera_devices').update({ status: r.data.status, classroom_id: r.data.classroomId ?? null }).eq('id', r.data.deviceId).select('id');
    return dbState(error, data);
  }, STAFF);
}

export async function resolveAlertAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(z.object({ alertId: uuid, status: z.enum(['confirmed', 'dismissed']), note: z.string().trim().min(3, { message: 'reason_required' }).max(1000, { message: 'message_too_long' }) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db
      .from('monitoring_alerts')
      .update({ status: r.data.status, resolution_note: r.data.note, resolved_by: userId, resolved_at: new Date().toISOString() })
      .eq('id', r.data.alertId)
      .eq('status', 'open')
      .select('id');
    return dbState(error, data);
  }, STAFF);
}

export async function runCheckAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ organizationId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.rpc('monitoring_check', { p_org: r.data.organizationId });
    if (error) return dbState(error);
    return { status: 'success', code: 'checked', data: { count: String(data ?? 0) } };
  }, STAFF);
}
