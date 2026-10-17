import { isLocale, type Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';

/**
 * Текст уведомления на языке получателя — один и тот же для кабинета, email и Telegram.
 * Хранится не готовый текст, а вид и данные события; текст собирается при показе/отправке.
 */
export type NotificationKind = keyof Dictionary['notify']['text'];

export interface Rendered {
  title: string;
  text: string;
  /** Путь внутри приложения (без домена) — ссылка ведёт на страницу, требующую входа. */
  path: string;
}

const str = (v: unknown, fallback = '—') => (typeof v === 'string' && v.trim() ? v : fallback);

function when(locale: Locale, iso: unknown, timeZone: unknown): string {
  if (typeof iso !== 'string') return '—';
  const tz = typeof timeZone === 'string' ? timeZone : 'Asia/Bishkek';
  try {
    return new Intl.DateTimeFormat(locale === 'ky' ? 'ky-KG' : locale === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function renderNotification(kind: string, payload: Record<string, unknown>, localeRaw: string | null | undefined): Rendered {
  const locale: Locale = isLocale(localeRaw) ? localeRaw : 'ru';
  const d = getDictionary(locale);
  const n = d.notify;
  const k = (kind in n.text ? kind : 'session_changed') as NotificationKind;
  const p = payload;
  const tz = p.timezone;
  const money = (v: unknown, cur: unknown) => `${str(v, '0.00')} ${str(cur, 'KGS')}`;
  const vars: Record<string, string> = {
    group: str(p.groupName),
    old: when(locale, p.oldStart, tz),
    new: when(locale, p.newStart, tz),
    start: when(locale, p.start, tz),
    kinds: Array.isArray(p.kinds) ? p.kinds.map((c) => d.schedule.changeKinds[c as keyof typeof d.schedule.changeKinds] ?? String(c)).join(', ') : '',
    title: str(p.title),
    due: p.dueAt ? when(locale, p.dueAt, tz) : n.noDue,
    result:
      k === 'exam_result' && p.absent === true
        ? n.examAbsent
        : p.status === 'returned'
          ? n.returned
          : fmt(n.graded, { score: p.score === null || p.score === undefined ? '—' : String(p.score), max: str(p.maxScore === undefined ? undefined : String(p.maxScore)) }),
    month: str(p.month),
    final:
      typeof p.grade === 'number'
        ? `${p.grade} (${String(p.final)}%)`
        : p.final !== null && p.final !== undefined
          ? `${String(p.final)}%`
          : '—',
    score: str(p.score),
    max: str(p.maxScore),
    number: str(p.number),
    dueOn: str(p.dueOn),
    amount: money(p.outstanding, p.currency),
    week: str(p.week),
    contacts: String(p.newContacts ?? 0),
    enrollments: String(p.newEnrollments ?? 0),
    received: `${str(p.received, '0.00')} KGS`,
    attendance: Number(p.attendanceMarked) > 0 ? `${Math.round((100 * Number(p.attendancePresent)) / Number(p.attendanceMarked))}%` : '—',
    failed: String(p.failedDeliveries ?? 0),
    actor: str(p.actorName),
  };
  let text = fmt(n.text[k], vars);
  if (typeof p.note === 'string' && p.note) text += ` ${fmt(n.note, { note: p.note })}`;
  return { title: n.kinds[k], text, path: pathFor(k, p) };
}

function pathFor(kind: NotificationKind, p: Record<string, unknown>): string {
  const id = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  switch (kind) {
    case 'session_rescheduled':
    case 'session_cancelled':
    case 'session_changed':
    case 'lesson_reminder':
    case 'absence_alert':
    case 'manager_alert':
      return id(p.sessionId) ? `/app/schedule/sessions/${id(p.sessionId)}` : '/app/schedule';
    case 'homework_assigned':
    case 'homework_graded':
      return id(p.assignmentId) ? `/app/learn/homework/${id(p.assignmentId)}` : '/app/learn';
    case 'submission_received':
      return '/app/groups';
    case 'test_result':
      return id(p.attemptId) ? `/app/learn/attempts/${id(p.attemptId)}` : '/app/learn';
    case 'payment_due':
    case 'payment_overdue':
      return '/app/billing';
    case 'monitoring_alert':
      return '/app/monitoring';
    case 'weekly_report':
      return '/app/finance';
    case 'task_assigned':
    case 'task_submitted':
    case 'task_returned':
    case 'task_accepted':
    case 'task_cancelled':
    case 'task_comment':
    case 'task_overdue':
      return id(p.taskId) ? `/app/tasks/${id(p.taskId)}` : '/app/tasks';
    case 'exam_result':
    case 'report_card':
      return '/app/learn/reports';
    case 'report_cards_ready':
      return id(p.groupId) ? `/app/groups/${id(p.groupId)}/grades${typeof p.month === 'string' && /^\d{4}-\d{2}$/.test(p.month) ? `?month=${p.month}` : ''}` : '/app/groups';
    case 'announcement':
    case 'announcement_ack':
      return id(p.announcementId) ? `/app/announcements/${id(p.announcementId)}` : '/app/announcements';
    default:
      return '/app/notifications';
  }
}

/** Письмо: только текст (без HTML — нечего экранировать и некуда внедрить разметку). */
export function emailBody(r: Rendered, locale: string | null | undefined, appUrl: string): { subject: string; text: string } {
  const n = getDictionary(isLocale(locale) ? locale : 'ru').notify;
  const lang = isLocale(locale) ? locale : 'ru';
  return { subject: `Okuspace: ${r.title}`, text: `${r.text}\n\n${n.open}: ${appUrl.replace(/\/$/, '')}/${lang}${r.path}\n` };
}
