'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { localeOf, parseForm, runAction, dbState } from '@/server/actions-util';
import type { FormErrorCode, FormState } from '@/server/auth/use-cases';
import { createPrivilegedClient, createUserClient } from '@/server/supabase/server';
import { ExercisesOutput, GrammarOutput, WritingCheckOutput, vetExercises, vetWritingCheck } from './outputs';
import { usdToMicro } from './pricing';
import { SCENARIOS, conversationSystem, exercisesSystem, grammarSystem, weakAreasPrompt, writingCheckSystem, type Scenario } from './prompts';
import { cleanInput, redactPersonalData } from './redact';
import { aiDeps } from './runtime';
import { runAi } from './service';
import { AiError, type AiMessage } from './types';

const PERSON = { mfa: false };
const STAFF = { mfa: true };
const PATHS = ['/app/ai'];
const uuid = z.uuid();
const lang = z.string().regex(/^[a-z]{2,3}$/);
const level = z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[A-Za-z0-9.+-]{1,16}$/).optional());
const text = (max: number) => z.string().transform(cleanInput).pipe(z.string().min(2, { message: 'body_required' }).max(max, { message: 'message_too_long' }));

const aiState = (error: unknown): FormState => {
  if (error instanceof AiError) return { status: 'error', code: error.code as FormErrorCode };
  logger.error('ai action failed', { error: error instanceof Error ? error.name : String(error) });
  return { status: 'error', code: 'ai_unavailable' };
};

// --- Диалог --------------------------------------------------------------------
const StartSchema = z.object({ organizationId: uuid, scenario: z.enum(SCENARIOS), targetLanguage: lang, level });

export async function startConversationAction(_p: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const state = await runAction(form, PATHS, async (userId) => {
    const r = parseForm(StartSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db
      .from('ai_conversations')
      .insert({ organization_id: r.data.organizationId, profile_id: userId, scenario: r.data.scenario, target_language: r.data.targetLanguage, level: r.data.level ?? null })
      .select('id')
      .single();
    if (error) return dbState(error);
    id = data.id as string;
    return { status: 'success', code: 'saved' };
  }, PERSON);
  if (id) redirect(`/${localeOf(form)}/app/ai/conversations/${id}`);
  return state;
}

const MessageSchema = z.object({ conversationId: uuid, content: text(1000) });
const HISTORY = 20;

export async function sendMessageAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(MessageSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data: conv } = await db.from('ai_conversations').select('id, organization_id, scenario, target_language, level').eq('id', r.data.conversationId).maybeSingle();
    if (!conv) return { status: 'error', code: 'forbidden' };
    const { data: past } = await db.from('ai_messages').select('role, content').eq('conversation_id', conv.id as string).order('id', { ascending: false }).limit(HISTORY);
    // Персональные данные убираются до отправки; сохраняется тоже очищенный текст — то, что ушло провайдеру.
    const content = redactPersonalData(r.data.content);
    const messages: AiMessage[] = [...((past ?? []) as AiMessage[]).reverse(), { role: 'user', content }];
    while (messages.length && messages[0]!.role !== 'user') messages.shift();
    try {
      const run = await runAi<string>(aiDeps(), conv.organization_id as string, {
        feature: 'conversation',
        system: conversationSystem(conv.scenario as Scenario, { targetLanguage: conv.target_language as string, level: (conv.level as string | null) ?? undefined, uiLanguage: localeOf(form) }),
        messages,
        maxOutputTokens: 400,
        timeoutMs: 30_000,
      });
      const { error } = await db.from('ai_messages').insert({ conversation_id: conv.id, role: 'user', content });
      if (error) return dbState(error);
      const { error: e2 } = await createPrivilegedClient().from('ai_messages').insert({ conversation_id: conv.id, role: 'assistant', content: run.output.slice(0, 8000), call_id: run.callId });
      if (e2) return dbState(e2);
      void userId;
      return { status: 'success', code: 'saved' };
    } catch (error) {
      return aiState(error);
    }
  }, PERSON);
}

// --- Проверка письма, грамматика, упражнения -----------------------------------
const WritingSchema = z.object({ organizationId: uuid, targetLanguage: lang, level, text: text(3000) });
const GrammarSchema = z.object({ organizationId: uuid, targetLanguage: lang, level, question: text(500) });
const ExercisesSchema = z.object({ organizationId: uuid, targetLanguage: lang, level, topic: z.preprocess((v) => (v === '' ? undefined : v), z.string().transform(cleanInput).pipe(z.string().max(200)).optional()) });

async function saveFeedback(org: string, userId: string, kind: 'writing_check' | 'grammar' | 'exercises', input: string, result: object, callId: string) {
  const { data, error } = await createPrivilegedClient()
    .from('ai_feedback')
    .insert({ organization_id: org, profile_id: userId, kind, input, result, call_id: callId })
    .select('id')
    .single();
  if (error) throw new Error(`ai_feedback insert failed: ${error.code}`);
  return data.id as string;
}

export async function checkWritingAction(_p: FormState, form: FormData): Promise<FormState> {
  let target: string | null = null;
  const state = await runAction(form, PATHS, async (userId) => {
    const r = parseForm(WritingSchema, form);
    if (!r.ok) return r.state;
    const input = redactPersonalData(r.data.text);
    const ctx = { targetLanguage: r.data.targetLanguage, level: r.data.level, uiLanguage: localeOf(form) };
    try {
      const run = await runAi(aiDeps(), r.data.organizationId, {
        feature: 'writing_check',
        system: writingCheckSystem(ctx),
        messages: [{ role: 'user', content: `Learner text:\n<<<\n${input}\n>>>` }],
        maxOutputTokens: 3000,
        schema: WritingCheckOutput,
        timeoutMs: 45_000,
      });
      const vetted = vetWritingCheck(input, run.output);
      if (!vetted) return { status: 'error', code: 'ai_invalid_output' };
      target = await saveFeedback(r.data.organizationId, userId, 'writing_check', input, { ...vetted.result, dropped: vetted.dropped }, run.callId);
      return { status: 'success', code: 'saved' };
    } catch (error) {
      return aiState(error);
    }
  }, PERSON);
  if (target) redirect(`/${localeOf(form)}/app/ai/feedback/${target}`);
  return state;
}

export async function explainGrammarAction(_p: FormState, form: FormData): Promise<FormState> {
  let target: string | null = null;
  const state = await runAction(form, PATHS, async (userId) => {
    const r = parseForm(GrammarSchema, form);
    if (!r.ok) return r.state;
    const question = redactPersonalData(r.data.question);
    try {
      const run = await runAi(aiDeps(), r.data.organizationId, {
        feature: 'grammar',
        system: grammarSystem({ targetLanguage: r.data.targetLanguage, level: r.data.level, uiLanguage: localeOf(form) }),
        messages: [{ role: 'user', content: question }],
        maxOutputTokens: 2000,
        schema: GrammarOutput,
        timeoutMs: 45_000,
      });
      target = await saveFeedback(r.data.organizationId, userId, 'grammar', question, run.output, run.callId);
      return { status: 'success', code: 'saved' };
    } catch (error) {
      return aiState(error);
    }
  }, PERSON);
  if (target) redirect(`/${localeOf(form)}/app/ai/feedback/${target}`);
  return state;
}

/** Слабые места ученика: категории ошибок из AI-проверок письма и навыки из неверных ответов тестов. */
async function weakAreas(userId: string) {
  const db = await createUserClient();
  const [{ data: fb }, { data: wrong }] = await Promise.all([
    db.from('ai_feedback').select('result').eq('profile_id', userId).eq('kind', 'writing_check').order('created_at', { ascending: false }).limit(10),
    db.from('attempt_answers').select('is_correct, assessment_questions(skill)').eq('is_correct', false).limit(50),
  ]);
  const areas = new Map<string, string[]>();
  for (const f of fb ?? []) {
    for (const c of ((f.result as { corrections?: { category: string; original: string }[] }).corrections ?? [])) {
      areas.set(c.category, [...(areas.get(c.category) ?? []), c.original]);
    }
  }
  for (const w of wrong ?? []) {
    const q = w.assessment_questions as unknown as { skill?: string } | { skill?: string }[] | null;
    const skill = (Array.isArray(q) ? q[0]?.skill : q?.skill) ?? null;
    if (skill) areas.set(skill, areas.get(skill) ?? []);
  }
  return [...areas.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4).map(([category, examples]) => ({ category, examples: examples.slice(0, 3) }));
}

export async function generateExercisesAction(_p: FormState, form: FormData): Promise<FormState> {
  let target: string | null = null;
  const state = await runAction(form, PATHS, async (userId) => {
    const r = parseForm(ExercisesSchema, form);
    if (!r.ok) return r.state;
    const prompt = weakAreasPrompt(await weakAreas(userId), r.data.topic ? redactPersonalData(r.data.topic) : undefined);
    try {
      const run = await runAi(aiDeps(), r.data.organizationId, {
        feature: 'exercises',
        system: exercisesSystem({ targetLanguage: r.data.targetLanguage, level: r.data.level, uiLanguage: localeOf(form) }),
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: 2500,
        schema: ExercisesOutput,
        timeoutMs: 45_000,
      });
      const vetted = vetExercises(run.output);
      if (!vetted) return { status: 'error', code: 'ai_invalid_output' };
      target = await saveFeedback(r.data.organizationId, userId, 'exercises', prompt, vetted, run.callId);
      return { status: 'success', code: 'saved' };
    } catch (error) {
      return aiState(error);
    }
  }, PERSON);
  if (target) redirect(`/${localeOf(form)}/app/ai/practice/${target}`);
  return state;
}

export async function submitPracticeAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const feedbackId = uuid.safeParse(form.get('feedbackId'));
    if (!feedbackId.success) return { status: 'error', code: 'validation' };
    const answers: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (/^e\d{1,2}$/.test(k) && typeof v === 'string') answers[k] = v.slice(0, 200);
    const db = await createUserClient();
    const { data, error } = await db.rpc('record_practice', { p_feedback: feedbackId.data, p_answers: answers });
    if (error) return dbState(error);
    const r = data as { correct: number; total: number };
    return { status: 'success', code: 'practice_checked', data: { correct: String(r.correct), total: String(r.total) } };
  }, PERSON);
}

// --- Споры --------------------------------------------------------------------
const DisputeSchema = z.object({ feedbackId: uuid, comment: z.string().trim().min(3, { message: 'reason_required' }).max(2000, { message: 'message_too_long' }) });
const ResolveSchema = z.object({ disputeId: uuid, decision: z.enum(['upheld', 'rejected']), resolution: z.string().trim().min(1, { message: 'reason_required' }).max(2000, { message: 'message_too_long' }) });

export async function openDisputeAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(DisputeSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.from('ai_feedback_disputes').insert({ feedback_id: r.data.feedbackId, opened_by: userId, comment: r.data.comment });
    return dbState(error);
  }, PERSON);
}

export async function resolveDisputeAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(ResolveSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db
      .from('ai_feedback_disputes')
      .update({ status: r.data.decision, resolution: r.data.resolution, resolved_by: userId, resolved_at: new Date().toISOString() })
      .eq('id', r.data.disputeId)
      .eq('status', 'open')
      .select('id');
    return dbState(error, data);
  }, PERSON);
}

// --- Настройки школы (директор, MFA) -----------------------------------------------
const SettingsSchema = z.object({
  organizationId: uuid,
  enabled: z.preprocess((v) => v === 'on' || v === 'true', z.boolean()),
  budgetUsd: z.string().refine((v) => usdToMicro(v) !== null, { message: 'price_invalid' }),
  dailyRequests: z.coerce.number().int().min(0, { message: 'count_invalid' }).max(1000, { message: 'count_invalid' }),
});

export async function saveAiSettingsAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(SettingsSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db
      .from('ai_settings')
      .upsert({
        organization_id: r.data.organizationId,
        enabled: r.data.enabled,
        monthly_budget_micro_usd: usdToMicro(r.data.budgetUsd),
        user_daily_requests: r.data.dailyRequests,
        updated_by: userId,
      })
      .select('organization_id');
    return dbState(error, data);
  }, STAFF);
}
