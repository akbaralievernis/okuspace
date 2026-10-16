import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckboxField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Card, Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { saveAiSettingsAction } from '@/server/ai/actions';
import { microToUsd } from '@/server/ai/pricing';
import { aiProviderInfo } from '@/server/ai/queries';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { createUserClient } from '@/server/supabase/server';

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export default async function AiSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/ai/settings`);
  const t = getDictionary(locale);
  const a = t.ai;
  const m = ctx.memberships;
  const orgIds = [...new Set(m.filter((x) => x.status === 'active' && can(m, 'ai.manage', x.organizationId, null)).map((x) => x.organizationId))];
  const provider = aiProviderInfo();
  const db = await createUserClient();
  const since = monthStart(new Date());
  const [{ data: orgs }, { data: settings }, { data: calls }] = orgIds.length
    ? await Promise.all([
        db.from('organizations').select('id, name').in('id', orgIds),
        db.from('ai_settings').select('organization_id, enabled, monthly_budget_micro_usd, user_daily_requests').in('organization_id', orgIds),
        db.from('ai_calls').select('organization_id, feature, status, cost_micro_usd, reserved_micro_usd').in('organization_id', orgIds).gte('created_at', since).limit(50_000),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={a.settingsTitle} allowed={orgIds.length > 0}>
      <p>
        <Link className="link" href={`/${locale}/app/ai`}>
          {a.back}
        </Link>
      </p>
      <Notice tone={provider ? 'info' : 'warning'}>{provider ? fmt(a.providerInfo, { name: provider.name, model: provider.model }) : a.providerMissing}</Notice>
      <p className="text-sm text-muted">{a.voiceOff}</p>
      {orgIds.map((org) => {
        const s = (settings ?? []).find((x) => x.organization_id === org);
        const list = (calls ?? []).filter((c) => c.organization_id === org);
        // Незавершённые вызовы считаются по резерву — как в БД при проверке бюджета.
        const spent = list.reduce((sum, c) => sum + Number(c.status === 'pending' ? c.reserved_micro_usd : (c.cost_micro_usd ?? 0)), 0);
        const failed = list.filter((c) => !['ok', 'pending'].includes(c.status as string)).length;
        const budget = Number(s?.monthly_budget_micro_usd ?? 0);
        return (
          <section key={org} aria-labelledby={`org-${org}`} className="space-y-4">
            <h2 id={`org-${org}`} className="text-xl font-bold">
              {((orgs ?? []).find((o) => o.id === org)?.name as string) ?? '—'}
            </h2>
            <ActionForm action={saveAiSettingsAction} submitLabel={a.save} pendingLabel={t.common.pending} messages={authMessages(t)} fieldLabels={{ budgetUsd: a.budget, dailyRequests: a.daily }} className="grid gap-4 sm:grid-cols-3">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="organizationId" value={org} />
              <CheckboxField name="enabled" label={a.enabled} defaultChecked={Boolean(s?.enabled)} idPrefix={`s-${org}`} />
              <Field name="budgetUsd" label={a.budget} inputMode="decimal" defaultValue={microToUsd(budget)} required idPrefix={`s-${org}`} />
              <Field name="dailyRequests" label={a.daily} type="number" min={0} max={1000} defaultValue={Number(s?.user_daily_requests ?? 30)} required idPrefix={`s-${org}`} />
            </ActionForm>
            <Card className="space-y-2">
              <h3 className="font-semibold">{a.usageTitle}</h3>
              <p>{fmt(a.spent, { spent: microToUsd(spent), budget: microToUsd(budget) })}</p>
              <p>{fmt(a.calls, { count: list.length, failed })}</p>
              <ul className="text-sm">
                {(['conversation', 'writing_check', 'grammar', 'exercises'] as const).map((f) => (
                  <li key={f}>
                    {a.features[f]}: {list.filter((c) => c.feature === f).length}
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        );
      })}
    </WorkspacePage>
  );
}
