import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Card, Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { checkWritingAction, explainGrammarAction, generateExercisesAction, startConversationAction } from '@/server/ai/actions';
import { SCENARIOS } from '@/server/ai/prompts';
import { aiProviderInfo, aiSchools, aiStats, type AiSchool } from '@/server/ai/queries';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { createUserClient } from '@/server/supabase/server';

export default async function AiLabPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/ai`);
  const t = getDictionary(locale);
  const a = t.ai;
  const msg = authMessages(t);
  const provider = aiProviderInfo();
  const schools = await aiSchools(ctx);
  const active = schools.filter((s) => s.enabled);
  const usable = provider !== null && active.length > 0;
  const m = ctx.memberships;
  const canSettings = m.some((x) => x.status === 'active' && can(m, 'ai.manage', x.organizationId, null));
  const canReview = m.some((x) => x.status === 'active' && (x.role === 'teacher' || can(m, 'learning.read_all', x.organizationId, x.branchId)));

  const db = await createUserClient();
  const [stats, { data: conversations }, { data: feedback }] = await Promise.all([
    aiStats(),
    db.from('ai_conversations').select('id, scenario, target_language, created_at').eq('profile_id', ctx.user.id).order('created_at', { ascending: false }).limit(10),
    db.from('ai_feedback').select('id, kind, input, created_at').eq('profile_id', ctx.user.id).order('created_at', { ascending: false }).limit(15),
  ]);
  const recommendations = stats ? Object.entries(stats.corrections).sort((x, y) => y[1] - x[1]).slice(0, 3) : [];
  const cat = (c: string) => a.categories[c as 'grammar'] ?? c;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={a.title} lead={a.lead}>
      {(canSettings || canReview) && (
        <p className="flex flex-wrap gap-4">
          {canSettings ? (
            <Link className="link" href={`/${locale}/app/ai/settings`}>
              {a.settingsLink}
            </Link>
          ) : null}
          {canReview ? (
            <Link className="link" href={`/${locale}/app/ai/reviews`}>
              {a.reviewsLink}
            </Link>
          ) : null}
        </p>
      )}

      {/* AI недоступен — понятное сообщение, обучение продолжает работать. */}
      {!provider ? <Notice tone="warning">{a.providerOff}</Notice> : active.length === 0 ? <Notice tone="warning">{a.schoolOff}</Notice> : null}
      <Notice tone="info">
        <p>{a.privacy}</p>
        <p className="mt-2">{a.limits}</p>
      </Notice>

      {stats ? (
        <section aria-labelledby="stats-h" className="space-y-3">
          <h2 id="stats-h" className="text-xl font-bold">
            {a.statsTitle}
          </h2>
          <dl className="grid gap-3 sm:grid-cols-4">
            {[
              [a.conversations, stats.conversations],
              [a.userTurns, stats.userTurns],
              [a.writingChecks, stats.writingChecks],
              [a.openDisputes, stats.openDisputes],
            ].map(([label, value]) => (
              <Card key={String(label)}>
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="text-2xl font-bold">{value}</dd>
              </Card>
            ))}
          </dl>
          {stats.practice.total > 0 ? <p>{fmt(a.practiceStat, { correct: stats.practice.correct, total: stats.practice.total })}</p> : null}
          <h3 className="text-lg font-semibold">{a.recommendTitle}</h3>
          {recommendations.length ? (
            <ul className="list-disc space-y-1 pl-6">
              {recommendations.map(([c, n]) => (
                <li key={c}>
                  {fmt(a.recommend, { category: cat(c) })} ({cat(c)}: {n})
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">{a.noRecommendations}</p>
          )}
        </section>
      ) : null}

      {usable ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <AiForm title={a.conversationTitle} id="conv">
            <ActionForm action={startConversationAction} submitLabel={a.startConversation} pendingLabel={t.common.pending} messages={msg}>
              <Common locale={locale} t={t} schools={active} prefix="conv" />
              <SelectField name="scenario" label={a.scenario} idPrefix="conv">
                {SCENARIOS.map((s) => (
                  <option key={s} value={s}>
                    {a.scenarios[s]}
                  </option>
                ))}
              </SelectField>
              <p className="text-sm text-muted">{a.voiceNote}</p>
            </ActionForm>
          </AiForm>
          <AiForm title={a.writingTitle} id="wr">
            <ActionForm action={checkWritingAction} submitLabel={a.check} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ text: a.yourText }}>
              <Common locale={locale} t={t} schools={active} prefix="wr" />
              <TextareaField name="text" label={a.yourText} hint={a.writingHint} required maxLength={3000} rows={8} idPrefix="wr" />
            </ActionForm>
          </AiForm>
          <AiForm title={a.grammarTitle} id="gr">
            <ActionForm action={explainGrammarAction} submitLabel={a.explain} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ question: a.question }}>
              <Common locale={locale} t={t} schools={active} prefix="gr" />
              <Field name="question" label={a.question} hint={a.grammarHint} required maxLength={500} idPrefix="gr" />
            </ActionForm>
          </AiForm>
          <AiForm title={a.exercisesTitle} id="ex">
            <p className="text-sm text-muted">{a.exercisesHint}</p>
            <ActionForm action={generateExercisesAction} submitLabel={a.createExercises} pendingLabel={t.common.pending} messages={msg}>
              <Common locale={locale} t={t} schools={active} prefix="ex" />
              <Field name="topic" label={a.topic} maxLength={200} idPrefix="ex" />
            </ActionForm>
          </AiForm>
        </div>
      ) : null}

      <section aria-labelledby="hist-h" className="space-y-4">
        <h2 id="hist-h" className="text-xl font-bold">
          {a.historyTitle}
        </h2>
        <h3 className="text-lg font-semibold">{a.conversationsTitle}</h3>
        {(conversations ?? []).length === 0 ? <p className="text-muted">{a.empty}</p> : null}
        <ul className="space-y-1">
          {(conversations ?? []).map((c) => (
            <li key={c.id as string}>
              <Link className="link" href={`/${locale}/app/ai/conversations/${c.id as string}`}>
                {a.scenarios[c.scenario as 'free']} · {(c.target_language as string).toUpperCase()}
              </Link>{' '}
              <span className="text-sm text-muted">{formatShortDateTime(locale, c.created_at as string, DEFAULT_TIMEZONE)}</span>
            </li>
          ))}
        </ul>
        <h3 className="text-lg font-semibold">{a.feedbackTitle}</h3>
        {(feedback ?? []).length === 0 ? <p className="text-muted">{a.empty}</p> : null}
        <ul className="space-y-1">
          {(feedback ?? []).map((f) => (
            <li key={f.id as string}>
              <Link className="link" href={`/${locale}/app/ai/${f.kind === 'exercises' ? 'practice' : 'feedback'}/${f.id as string}`}>
                {a.kinds[f.kind as 'grammar']}
              </Link>{' '}
              <span className="text-sm text-muted">
                {formatShortDateTime(locale, f.created_at as string, DEFAULT_TIMEZONE)} · {(f.input as string).slice(0, 60)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </WorkspacePage>
  );
}

function AiForm({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3 rounded-[var(--radius-card)] border border-border p-4">
      <h2 id={`${id}-h`} className="text-xl font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Общие поля: школа (если их несколько), язык изучения, уровень. */
function Common({ locale, t, schools, prefix }: { locale: string; t: Dictionary; schools: AiSchool[]; prefix: string }) {
  const a = t.ai;
  const school = schools[0]!;
  const languages = school.languages.length ? school.languages : [{ code: 'en', name: 'English' }];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <input type="hidden" name="locale" value={locale} />
      {schools.length > 1 ? (
        <SelectField name="organizationId" label={a.school} idPrefix={prefix}>
          {schools.map((s) => (
            <option key={s.organizationId} value={s.organizationId}>
              {s.name}
            </option>
          ))}
        </SelectField>
      ) : (
        <input type="hidden" name="organizationId" value={school.organizationId} />
      )}
      <SelectField name="targetLanguage" label={a.language} idPrefix={prefix}>
        {languages.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </SelectField>
      <SelectField name="level" label={a.level} idPrefix={prefix}>
        <option value="">—</option>
        {school.levels.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </SelectField>
    </div>
  );
}
