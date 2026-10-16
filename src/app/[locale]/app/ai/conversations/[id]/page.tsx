import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TextareaField } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { SpeakButton } from '@/features/ai/speak-button';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { sendMessageAction } from '@/server/ai/actions';
import { aiProviderInfo } from '@/server/ai/queries';
import { requireAccess } from '@/server/auth/session';
import { createUserClient } from '@/server/supabase/server';

export default async function ConversationPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/ai/conversations/${id}`);
  const t = getDictionary(locale);
  const a = t.ai;
  const db = await createUserClient();
  // RLS: диалог виден только владельцу.
  const { data: conv } = await db.from('ai_conversations').select('id, organization_id, scenario, target_language, level').eq('id', id).maybeSingle();
  if (!conv) notFound();
  const [{ data: messages }, { data: settings }] = await Promise.all([
    db.from('ai_messages').select('id, role, content').eq('conversation_id', id).order('id'),
    db.from('ai_settings').select('enabled').eq('organization_id', conv.organization_id as string).maybeSingle(),
  ]);
  const available = aiProviderInfo() !== null && Boolean(settings?.enabled);
  const target = conv.target_language as string;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={`${a.conversationTitle}: ${a.scenarios[conv.scenario as 'free']}`}>
      <p>
        <Link className="link" href={`/${locale}/app/ai`}>
          {a.back}
        </Link>
      </p>
      <p className="text-sm text-muted">{a.limits}</p>
      {(messages ?? []).length === 0 ? <p className="text-muted">{a.startHint}</p> : null}
      <ol className="space-y-3" aria-live="polite">
        {(messages ?? []).map((msg) => {
          const mine = msg.role === 'user';
          return (
            <li key={String(msg.id)} className={`max-w-prose rounded-[var(--radius-card)] border p-3 ${mine ? 'ml-auto border-brand-700 bg-brand-50' : 'border-border bg-surface'}`}>
              <p className="text-sm font-semibold">{mine ? a.you : a.partner}</p>
              <p className="whitespace-pre-wrap" lang={target}>
                {msg.content as string}
              </p>
              {!mine ? <SpeakButton text={msg.content as string} lang={target} label={a.listen} /> : null}
            </li>
          );
        })}
      </ol>
      {available ? (
        <ActionForm action={sendMessageAction} submitLabel={a.send} pendingLabel={t.common.pending} messages={authMessages(t)} fieldLabels={{ content: a.message }}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="conversationId" value={id} />
          <TextareaField name="content" label={a.message} hint={a.privacy} required maxLength={1000} rows={3} idPrefix="msg" lang={target} />
        </ActionForm>
      ) : (
        <Notice tone="warning">{aiProviderInfo() ? a.schoolOff : a.providerOff}</Notice>
      )}
      <p className="text-sm text-muted">{a.voiceNote}</p>
    </WorkspacePage>
  );
}
