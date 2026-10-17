import { describe, expect, it } from 'vitest';
import { locales as LOCALES } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { emailBody, renderNotification } from '@/server/notifications/render';

const SESSION = '11111111-1111-4111-8111-111111111111';
const payloads: Record<string, Record<string, unknown>> = {
  session_rescheduled: { sessionId: SESSION, groupName: 'A1', oldStart: '2026-10-20T08:00:00Z', newStart: '2026-10-21T08:00:00Z', timezone: 'Asia/Bishkek' },
  session_cancelled: { sessionId: SESSION, groupName: 'A1', oldStart: '2026-10-20T08:00:00Z', note: 'болезнь' },
  session_changed: { sessionId: SESSION, groupName: 'A1', kinds: ['room', 'teacher'] },
  lesson_reminder: { sessionId: SESSION, groupName: 'A1', start: '2026-10-20T08:00:00Z' },
  homework_assigned: { assignmentId: SESSION, title: 'Essay', dueAt: '2026-10-22T18:00:00Z' },
  homework_graded: { assignmentId: SESSION, title: 'Essay', status: 'graded', score: '8', maxScore: '10' },
  submission_received: { assignmentId: SESSION, title: 'Essay', studentName: 'Aibek' },
  test_result: { attemptId: SESSION, title: 'Unit 1', score: '7', maxScore: '10' },
  absence_alert: { sessionId: SESSION, groupName: 'A1', start: '2026-10-20T08:00:00Z' },
  payment_due: { number: 'N-0001', dueOn: '2026-10-19', outstanding: '1500.00', currency: 'KGS' },
  payment_overdue: { number: 'N-0002', dueOn: '2026-10-01', outstanding: '900.00', currency: 'KGS' },
  manager_alert: { sessionId: SESSION, groupName: 'A1', start: '2026-10-20T08:00:00Z' },
  monitoring_alert: {},
  task_assigned: { taskId: SESSION, title: 'Отчёт', dueAt: '2026-10-25T12:00:00Z', actorName: 'Айгуль', priority: 'high' },
  task_submitted: { taskId: SESSION, title: 'Отчёт', actorName: 'Нурия', note: 'Готово' },
  task_returned: { taskId: SESSION, title: 'Отчёт', actorName: 'Айгуль', note: 'Добавьте цифры' },
  task_accepted: { taskId: SESSION, title: 'Отчёт', actorName: 'Айгуль' },
  task_cancelled: { taskId: SESSION, title: 'Отчёт', actorName: 'Айгуль', note: 'Не нужно' },
  task_comment: { taskId: SESSION, title: 'Отчёт', actorName: 'Нурия', note: 'Вопрос' },
  task_overdue: { taskId: SESSION, title: 'Отчёт', dueAt: '2026-10-20T12:00:00Z', actorName: 'Нурия' },
  announcement: { announcementId: SESSION, title: 'Собрание', actorName: 'Айгуль' },
  announcement_ack: { announcementId: SESSION, title: 'Новые правила', actorName: 'Айгуль' },
  exam_result: { examId: SESSION, title: 'Speaking', score: 40, maxScore: 50, absent: false },
  report_card: { reportId: SESSION, month: '2026-09', final: 73, grade: 3 },
  report_cards_ready: { groupId: SESSION, groupName: 'A1', month: '2026-09' },
  weekly_report: { week: '2026-42', newContacts: 3, newEnrollments: 2, received: '12000.00', attendanceMarked: 10, attendancePresent: 9, failedDeliveries: 0 },
};

describe('renderNotification', () => {
  it('covers every kind in the catalog in every language without leftovers', () => {
    const kinds = Object.keys(getDictionary('ru').notify.text);
    expect([...kinds].sort()).toEqual(Object.keys(payloads).sort());
    for (const locale of LOCALES) {
      for (const kind of kinds) {
        const r = renderNotification(kind, payloads[kind]!, locale);
        expect(r.title, `${locale}/${kind}`).toBeTruthy();
        expect(r.text, `${locale}/${kind}`).not.toMatch(/\{[a-z]+\}|undefined|NaN|\[object/);
        expect(r.path.startsWith('/app/'), `${locale}/${kind}`).toBe(true);
      }
    }
  });

  it('localizes values and links to the right pages', () => {
    expect(renderNotification('weekly_report', payloads.weekly_report!, 'ru').text).toContain('90%');
    expect(renderNotification('payment_due', payloads.payment_due!, 'en').text).toContain('1500.00 KGS');
    expect(renderNotification('session_cancelled', payloads.session_cancelled!, 'ru').text).toContain('болезнь');
    expect(renderNotification('lesson_reminder', payloads.lesson_reminder!, 'ru').path).toBe(`/app/schedule/sessions/${SESSION}`);
    expect(renderNotification('test_result', payloads.test_result!, 'ru').path).toBe(`/app/learn/attempts/${SESSION}`);
    expect(renderNotification('payment_overdue', payloads.payment_overdue!, 'ky').path).toBe('/app/billing');
    expect(renderNotification('task_assigned', payloads.task_assigned!, 'ru').path).toBe(`/app/tasks/${SESSION}`);
    expect(renderNotification('task_assigned', payloads.task_assigned!, 'ru').text).toContain('Айгуль');
    expect(renderNotification('task_returned', payloads.task_returned!, 'en').text).toContain('Добавьте цифры');
    expect(renderNotification('announcement_ack', payloads.announcement_ack!, 'ky').path).toBe(`/app/announcements/${SESSION}`);
    expect(renderNotification('task_overdue', { taskId: 'javascript:alert(1)' }, 'ru').path).toBe('/app/tasks');
    expect(renderNotification('exam_result', payloads.exam_result!, 'ru').text).toContain('40 из 50');
    expect(renderNotification('exam_result', { title: 'Speaking', score: null, maxScore: 50, absent: true }, 'ru').text).toContain(getDictionary('ru').notify.examAbsent);
    expect(renderNotification('report_card', payloads.report_card!, 'en').text).toContain('3 (73%)');
    expect(renderNotification('report_card', { month: '2026-09', final: 81.5, grade: null }, 'en').text).toContain('81.5%');
    expect(renderNotification('report_cards_ready', payloads.report_cards_ready!, 'ru').path).toBe(`/app/groups/${SESSION}/grades?month=2026-09`);
    expect(renderNotification('report_cards_ready', { groupId: SESSION, month: '2026-09&x=1' }, 'ru').path).toBe(`/app/groups/${SESSION}/grades`);
    const returned = renderNotification('homework_graded', { ...payloads.homework_graded, status: 'returned' }, 'ru').text;
    expect(returned).toContain(getDictionary('ru').notify.returned);
  });

  it('never builds links from untrusted ids and falls back on unknown input', () => {
    expect(renderNotification('lesson_reminder', { sessionId: '../../admin' }, 'ru').path).toBe('/app/schedule');
    expect(renderNotification('homework_assigned', { assignmentId: 'https://evil.example' }, 'ru').path).toBe('/app/learn');
    const unknown = renderNotification('nope', {}, 'xx');
    expect(unknown.title).toBe(getDictionary('ru').notify.kinds.session_changed);
  });

  it('email is plain text with an absolute link in the recipient language', () => {
    const r = renderNotification('payment_due', payloads.payment_due!, 'en');
    const mail = emailBody(r, 'en', 'https://okuspace.example/');
    expect(mail.subject).toBe(`Okuspace: ${r.title}`);
    expect(mail.text).toContain('https://okuspace.example/en/app/billing');
    expect(mail.text).not.toMatch(/<[a-z]/i);
  });
});
