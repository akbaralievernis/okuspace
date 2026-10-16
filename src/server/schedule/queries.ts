import 'server-only';

import { z } from 'zod';
import { logger } from '@/lib/logger';
import { createUserClient } from '@/server/supabase/server';

const nullableUuid = z.uuid().nullable();

export const SessionItemSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  branchId: z.uuid(),
  branchName: z.string(),
  timezone: z.string(),
  groupId: z.uuid(),
  groupName: z.string(),
  teacherId: z.uuid(),
  teacherName: z.string().nullable(),
  classroomId: nullableUuid,
  classroomName: z.string().nullable(),
  onlineUrl: z.string().nullable(),
  start: z.string(),
  end: z.string(),
  status: z.enum(['scheduled', 'done', 'cancelled']),
  topic: z.string().nullable(),
  cancelReason: z.string().nullable(),
  marks: z.array(z.object({ studentId: z.uuid(), studentName: z.string().nullable(), status: z.string() })),
});
export type SessionItem = z.infer<typeof SessionItemSchema>;

/** Занятия за период (не больше 62 дней) — то, что разрешает RLS. null — БД недоступна. */
export async function scheduleWindow(from: Date, to: Date): Promise<SessionItem[] | null> {
  const db = await createUserClient();
  const { data, error } = await db.rpc('schedule_window', { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) {
    logger.error('schedule_window failed', { code: error.code });
    return null;
  }
  const parsed = z.array(SessionItemSchema).safeParse(data);
  if (!parsed.success) {
    logger.error('schedule_window shape mismatch', { issues: parsed.error.issues.slice(0, 3) });
    return null;
  }
  return parsed.data;
}

export interface Notification {
  id: string;
  kind: 'session_rescheduled' | 'session_cancelled' | 'session_changed';
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export async function myNotifications(limit = 100): Promise<Notification[] | null> {
  const db = await createUserClient();
  const { data, error } = await db.from('notifications').select('id, kind, payload, read_at, created_at').order('created_at', { ascending: false }).limit(limit);
  if (error) return null;
  return (data ?? []).map((n) => ({
    id: n.id as string,
    kind: n.kind as Notification['kind'],
    payload: (n.payload ?? {}) as Record<string, unknown>,
    readAt: (n.read_at as string | null) ?? null,
    createdAt: n.created_at as string,
  }));
}
