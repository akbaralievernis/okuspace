import 'server-only';

import { z } from 'zod';
import type { AccessContext } from '@/server/auth/session';
import { createUserClient } from '@/server/supabase/server';
import { getAiProvider } from './runtime';

export interface AiSchool {
  organizationId: string;
  name: string;
  enabled: boolean;
  languages: { code: string; name: string }[];
  levels: string[];
}

/** Школы пользователя и их AI-настройки (RLS: только свои школы). */
export async function aiSchools(ctx: AccessContext): Promise<AiSchool[]> {
  const orgIds = [...new Set(ctx.memberships.filter((m) => m.status === 'active').map((m) => m.organizationId))];
  if (!orgIds.length) return [];
  const db = await createUserClient();
  const [{ data: orgs }, { data: settings }, { data: languages }, { data: levels }] = await Promise.all([
    db.from('organizations').select('id, name').in('id', orgIds),
    db.from('ai_settings').select('organization_id, enabled').in('organization_id', orgIds),
    db.from('languages').select('organization_id, code, name').in('organization_id', orgIds).order('name'),
    db.from('course_levels').select('organization_id, code, sort_order').in('organization_id', orgIds).order('sort_order'),
  ]);
  return orgIds.map((id) => ({
    organizationId: id,
    name: ((orgs ?? []).find((o) => o.id === id)?.name as string) ?? '—',
    enabled: Boolean((settings ?? []).find((s) => s.organization_id === id)?.enabled),
    languages: (languages ?? []).filter((l) => l.organization_id === id).map((l) => ({ code: l.code as string, name: l.name as string })),
    levels: [...new Set((levels ?? []).filter((l) => l.organization_id === id).map((l) => l.code as string))],
  }));
}

export const aiProviderInfo = () => {
  const p = getAiProvider();
  return p ? { name: p.name, model: p.model } : null;
};

export const StatsSchema = z.object({
  conversations: z.number(),
  userTurns: z.number(),
  writingChecks: z.number(),
  corrections: z.record(z.string(), z.number()),
  practice: z.object({ sets: z.number(), correct: z.number(), total: z.number() }),
  openDisputes: z.number(),
});
export type AiStats = z.infer<typeof StatsSchema>;

export async function aiStats(studentId?: string): Promise<AiStats | null> {
  const db = await createUserClient();
  const { data, error } = await db.rpc('ai_lab_stats', { p_student: studentId ?? null, p_days: 30 });
  if (error) return null;
  const parsed = StatsSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
