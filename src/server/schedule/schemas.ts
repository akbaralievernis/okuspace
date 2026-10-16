import { z } from 'zod';

/** Формы расписания и посещаемости. Конфликты, права и окна отметки окончательно проверяет БД. */
const uuid = z.uuid();
const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_invalid' });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'time_invalid' });
const minutes = z.coerce.number().int().min(15, { message: 'duration_invalid' }).max(480, { message: 'duration_invalid' });
const onlineUrl = z.preprocess(blankToUndefined, z.url({ protocol: /^https$/, message: 'url_invalid' }).max(500, { message: 'url_invalid' }).optional());
const classroomId = z.preprocess(blankToUndefined, uuid.optional());

export const ClassroomSchema = z.object({
  organizationId: uuid,
  branchId: uuid,
  name: z.string().trim().min(1, { message: 'title_required' }).max(100, { message: 'title_required' }),
  capacity: z.coerce.number().int().min(1, { message: 'capacity_invalid' }).max(500, { message: 'capacity_invalid' }),
});

export const ClassroomStatusSchema = z.object({ classroomId: uuid, status: z.enum(['active', 'archived']) });

/** Серия занятий: дни недели (ISO, 1 = пн) приходят несколькими полями weekdays. */
export const SeriesSchema = z
  .object({
    groupId: uuid,
    teacherId: uuid,
    classroomId,
    onlineUrl,
    firstDate: date,
    weekdays: z.array(z.coerce.number().int().min(1).max(7)).min(1, { message: 'weekdays_required' }),
    startTime: time,
    minutes,
    count: z.coerce.number().int().min(1, { message: 'count_invalid' }).max(200, { message: 'count_invalid' }),
    topic: optionalText(200),
  })
  .refine((v) => v.classroomId || v.onlineUrl, { message: 'place_required', path: ['classroomId'], when: () => true });

export const RescheduleSchema = z
  .object({
    sessionId: uuid,
    date,
    startTime: time,
    minutes,
    classroomId,
    onlineUrl,
    note: optionalText(500),
  })
  .refine((v) => v.classroomId || v.onlineUrl, { message: 'place_required', path: ['classroomId'], when: () => true });

export const CancelSchema = z.object({
  sessionId: uuid,
  reason: z.string().trim().min(3, { message: 'reason_required' }).max(500, { message: 'reason_required' }),
});

export const ATTENDANCE_STATUSES = ['present', 'late', 'left_early', 'absent', 'excused'] as const;
export const ABSENCE_REASONS = ['illness', 'family', 'transport', 'other'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface Mark {
  studentId: string;
  status: AttendanceStatus;
  minutesLate?: number;
  absenceReason?: (typeof ABSENCE_REASONS)[number];
  note?: string;
}

/**
 * Отметки из формы журнала: для каждого ученика поля status_<id>, late_<id>, reason_<id>, note_<id>.
 * Ученики без выбранного статуса пропускаются (их отметка не меняется).
 */
export function marksFromForm(form: FormData, studentIds: string[]): { marks: Mark[]; invalid: string[] } {
  const marks: Mark[] = [];
  const invalid: string[] = [];
  for (const id of studentIds) {
    const status = form.get(`status_${id}`);
    if (typeof status !== 'string' || status === '') continue;
    if (!(ATTENDANCE_STATUSES as readonly string[]).includes(status)) {
      invalid.push(id);
      continue;
    }
    const mark: Mark = { studentId: id, status: status as AttendanceStatus };
    const late = String(form.get(`late_${id}`) ?? '').trim();
    if (status === 'late' && late !== '') {
      const n = Number(late);
      if (!Number.isInteger(n) || n < 1 || n > 480) {
        invalid.push(id);
        continue;
      }
      mark.minutesLate = n;
    }
    const reason = String(form.get(`reason_${id}`) ?? '');
    if ((status === 'absent' || status === 'excused') && (ABSENCE_REASONS as readonly string[]).includes(reason)) {
      mark.absenceReason = reason as Mark['absenceReason'];
    }
    const note = String(form.get(`note_${id}`) ?? '').trim();
    if (note) mark.note = note.slice(0, 500);
    marks.push(mark);
  }
  return { marks, invalid };
}

export const CheckInSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, { message: 'code_invalid' }) });

/** Понедельник недели, в которую попадает дата 'YYYY-MM-DD' (календарная дата, без часовых поясов). */
export function weekStart(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Календарная дата момента времени в поясе филиала. */
export function localDate(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * tstzrange в текстовом виде PostgreSQL/PostgREST — '["2026-11-02 04:00:00+00","2026-11-02 05:30:00+00")' —
 * в пару ISO-моментов [начало, конец).
 */
export function parsePeriod(range: string): [string, string] {
  const m = /^[[(]"?([^",]+)"?,"?([^",]+)"?[\])]$/.exec(range.trim());
  if (!m) throw new Error('invalid period');
  const iso = (v: string) => {
    const d = new Date(v.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    if (Number.isNaN(d.getTime())) throw new Error('invalid period');
    return d.toISOString();
  };
  return [iso(m[1]!), iso(m[2]!)];
}

/**
 * Окна отметки (те же правила, что в БД: app.can_mark_session / app.can_correct_attendance):
 * открыто с 15 минут до начала; преподаватель — до 48 часов после конца.
 * Только для выбора формы на странице — окончательно проверяет БД.
 */
export function markingWindow(startIso: string, endIso: string, now: number = Date.now()) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return {
    opened: now >= start - 15 * 60_000,
    teacherOpen: now >= start - 15 * 60_000 && now <= end + 48 * 3_600_000,
    running: now <= end,
  };
}
