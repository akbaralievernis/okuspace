import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Card } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { saveGradingPolicyAction } from '@/server/grading/actions';
import { createUserClient } from '@/server/supabase/server';

/** Правила итоговой оценки школы — директор (grading.manage, MFA). */
export default async function GradingPolicyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/grading`);
  const t = getDictionary(locale);
  const gr = t.grades;
  const msg = authMessages(t);
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const org = m.find((x) => can(m, 'grading.manage', x.organizationId, null))?.organizationId;
  const db = await createUserClient();
  const { data: policy } = org ? await db.from('grading_policies').select('*').eq('organization_id', org).maybeSingle() : { data: null };
  const v = {
    attendance: (policy?.weight_attendance as number | undefined) ?? 20,
    homework: (policy?.weight_homework as number | undefined) ?? 30,
    tests: (policy?.weight_tests as number | undefined) ?? 20,
    exam: (policy?.weight_exam as number | undefined) ?? 30,
    scale: (policy?.scale as string | undefined) ?? 'five',
  };

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={gr.policyTitle} allowed={Boolean(org)}>
      <Card>
        <p className="mb-4 text-sm text-muted">{gr.policyHint}</p>
        <ActionForm
          action={saveGradingPolicyAction}
          submitLabel={gr.savePolicy}
          pendingLabel={t.common.pending}
          messages={msg}
          fieldLabels={{ attendance: gr.wAttendance, homework: gr.wHomework, tests: gr.wTests, exam: gr.wExam }}
        >
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="organizationId" value={org ?? ''} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="attendance" type="number" min={0} max={100} step={1} label={gr.wAttendance} defaultValue={String(v.attendance)} idPrefix="gp" />
            <Field name="homework" type="number" min={0} max={100} step={1} label={gr.wHomework} defaultValue={String(v.homework)} idPrefix="gp" />
            <Field name="tests" type="number" min={0} max={100} step={1} label={gr.wTests} defaultValue={String(v.tests)} idPrefix="gp" />
            <Field name="exam" type="number" min={0} max={100} step={1} label={gr.wExam} defaultValue={String(v.exam)} idPrefix="gp" />
          </div>
          <SelectField name="scale" label={gr.scale} defaultValue={v.scale} idPrefix="gp">
            <option value="five">{gr.scales.five}</option>
            <option value="percent">{gr.scales.percent}</option>
          </SelectField>
        </ActionForm>
      </Card>
      <details className="text-sm">
        <summary className="cursor-pointer font-semibold">{gr.definitionsTitle}</summary>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          {gr.definitions.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </details>
    </WorkspacePage>
  );
}
