import { describe, expect, it } from 'vitest';
import { CheckInSchema, RescheduleSchema, SeriesSchema, addDays, localDate, marksFromForm, markingWindow, parsePeriod, weekStart } from '@/server/schedule/schemas';

const G = '5a100000-0000-4000-8000-000000000001';
const T = '00000000-0000-4000-8000-000000000015';
const R = '4a100000-0000-4000-8000-000000000001';
const S1 = '00000000-0000-4000-8000-000000000020';
const S2 = '00000000-0000-4000-8000-000000000021';
const S3 = '00000000-0000-4000-8000-000000000022';

describe('SeriesSchema', () => {
  const base = { groupId: G, teacherId: T, classroomId: R, onlineUrl: '', firstDate: '2027-01-04', weekdays: ['1', '3'], startTime: '18:00', minutes: '90', count: '4', topic: '' };

  it('accepts a weekly series and coerces numbers', () => {
    expect(SeriesSchema.parse(base)).toMatchObject({ weekdays: [1, 3], minutes: 90, count: 4, classroomId: R, onlineUrl: undefined, topic: undefined });
  });

  it('needs a weekday, a valid time and a bounded count', () => {
    const issues = (v: object) => SeriesSchema.safeParse({ ...base, ...v }).error?.issues.map((i) => i.message);
    expect(issues({ weekdays: [] })).toContain('weekdays_required');
    expect(issues({ weekdays: ['8'] })).toBeDefined();
    expect(issues({ startTime: '24:00' })).toContain('time_invalid');
    expect(issues({ count: '0' })).toContain('count_invalid');
    expect(issues({ minutes: '10' })).toContain('duration_invalid');
  });

  it('needs a classroom or an https link — and reports it together with other errors', () => {
    const r = SeriesSchema.safeParse({ ...base, classroomId: '', onlineUrl: '', startTime: 'x' });
    expect(r.error?.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['place_required', 'time_invalid']));
    expect(SeriesSchema.safeParse({ ...base, classroomId: '', onlineUrl: 'http://meet.example.test/x' }).success).toBe(false);
    expect(SeriesSchema.safeParse({ ...base, classroomId: '', onlineUrl: 'https://meet.example.test/x' }).success).toBe(true);
  });
});

describe('RescheduleSchema and CheckInSchema', () => {
  it('reschedule requires a place', () => {
    const v = { sessionId: G, date: '2026-11-03', startTime: '10:00', minutes: '90', classroomId: '', onlineUrl: '', note: '' };
    expect(RescheduleSchema.safeParse(v).error?.issues.map((i) => i.message)).toContain('place_required');
    expect(RescheduleSchema.parse({ ...v, classroomId: R }).note).toBeUndefined();
  });

  it('session codes are six digits', () => {
    expect(CheckInSchema.safeParse({ code: ' 012345 ' }).data).toEqual({ code: '012345' });
    expect(CheckInSchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(CheckInSchema.safeParse({ code: '12345a' }).success).toBe(false);
  });
});

describe('marksFromForm', () => {
  it('reads one mark per student, keeps lateness only for "late" and reasons only for absences', () => {
    const form = new FormData();
    form.set(`status_${S1}`, 'late');
    form.set(`late_${S1}`, '12');
    form.set(`reason_${S1}`, 'illness');
    form.set(`status_${S2}`, 'absent');
    form.set(`late_${S2}`, '7');
    form.set(`reason_${S2}`, 'illness');
    form.set(`note_${S2}`, '  called  ');
    form.set(`status_${S3}`, '');
    expect(marksFromForm(form, [S1, S2, S3])).toEqual({
      marks: [
        { studentId: S1, status: 'late', minutesLate: 12 },
        { studentId: S2, status: 'absent', absenceReason: 'illness', note: 'called' },
      ],
      invalid: [],
    });
  });

  it('flags unknown statuses and impossible lateness instead of saving them', () => {
    const form = new FormData();
    form.set(`status_${S1}`, 'sleeping');
    form.set(`status_${S2}`, 'late');
    form.set(`late_${S2}`, '999');
    form.set(`reason_${S3}`, 'bribe');
    form.set(`status_${S3}`, 'excused');
    expect(marksFromForm(form, [S1, S2, S3])).toEqual({ marks: [{ studentId: S3, status: 'excused' }], invalid: [S1, S2] });
  });

  it('ignores fields of students who are not in the roster', () => {
    const form = new FormData();
    form.set(`status_${S3}`, 'present');
    expect(marksFromForm(form, [S1]).marks).toEqual([]);
  });
});

describe('calendar dates and periods', () => {
  it('weekStart returns the Monday of the ISO week', () => {
    expect(weekStart('2026-11-02')).toBe('2026-11-02'); // понедельник
    expect(weekStart('2026-11-08')).toBe('2026-11-02'); // воскресенье
    expect(weekStart('2027-01-01')).toBe('2026-12-28'); // через границу года
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
  });

  it('localDate uses the branch time zone, not UTC', () => {
    // 2026-11-01 20:00Z — уже 2 ноября в Бишкеке (UTC+6), ещё 1 ноября в Берлине.
    expect(localDate('2026-11-01T20:00:00Z', 'Asia/Bishkek')).toBe('2026-11-02');
    expect(localDate('2026-11-01T20:00:00Z', 'Europe/Berlin')).toBe('2026-11-01');
  });

  it('parsePeriod reads the PostgreSQL tstzrange text format', () => {
    expect(parsePeriod('["2026-11-02 04:00:00+00","2026-11-02 05:30:00+00")')).toEqual(['2026-11-02T04:00:00.000Z', '2026-11-02T05:30:00.000Z']);
    expect(parsePeriod('["2026-11-02 10:00:00+06","2026-11-02 11:30:00+06")')).toEqual(['2026-11-02T04:00:00.000Z', '2026-11-02T05:30:00.000Z']);
    expect(parsePeriod('[2026-11-02T04:00:00Z,2026-11-02T05:30:00Z)')).toEqual(['2026-11-02T04:00:00.000Z', '2026-11-02T05:30:00.000Z']);
    expect(() => parsePeriod('empty')).toThrow();
  });

  it('markingWindow mirrors the database rules', () => {
    const start = '2026-11-02T04:00:00Z';
    const end = '2026-11-02T05:30:00Z';
    const at = (iso: string) => markingWindow(start, end, Date.parse(iso));
    expect(at('2026-11-02T03:44:00Z')).toEqual({ opened: false, teacherOpen: false, running: true });
    expect(at('2026-11-02T03:46:00Z')).toEqual({ opened: true, teacherOpen: true, running: true });
    expect(at('2026-11-04T05:29:00Z')).toEqual({ opened: true, teacherOpen: true, running: false });
    expect(at('2026-11-04T05:31:00Z')).toEqual({ opened: true, teacherOpen: false, running: false });
  });
});
