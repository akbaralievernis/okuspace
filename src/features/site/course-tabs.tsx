'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Bubble, Icon } from './brand';

export interface TabCourse {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  ageNote: string | null;
  price: string;
  href: string;
}

const ICON: Record<string, 'globe' | 'exam' | 'book' | 'code' | 'chat'> = { english: 'chat', exams: 'exam', languages: 'globe', school: 'book', it: 'code' }; // английский — «разговор», языки — «глобус»

/** Курсы с фильтром-вкладками по разделам; без JavaScript показываются все. */
export function CourseTabs({ courses, labels, allLabel, moreLabel }: { courses: TabCourse[]; labels: Record<string, string>; allLabel: string; moreLabel: string }) {
  const [tab, setTab] = useState<string>('all');
  const categories = [...new Set(courses.map((c) => c.category ?? 'other'))];
  const shown = tab === 'all' ? courses : courses.filter((c) => (c.category ?? 'other') === tab);
  return (
    <div className="space-y-6">
      <div role="toolbar" aria-label={allLabel} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {['all', ...categories].map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={tab === c}
            onClick={() => setTab(c)}
            className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-bold uppercase tracking-[0.02em] ${tab === c ? 'bg-brand-700 text-white' : 'bg-surface-muted text-brand-800 hover:bg-brand-50'}`}
          >
            {c === 'all' ? allLabel : (labels[c] ?? c)}
          </button>
        ))}
      </div>
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((c) => (
          <li key={c.id} className="relative flex flex-col gap-3 rounded-[var(--radius-card)] bg-surface p-5 shadow-[var(--shadow-card)]">
            <div className="flex items-start justify-between gap-3">
              <span className="inline-flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                <Icon name={ICON[c.category ?? ''] ?? 'book'} />
              </span>
              {c.category ? <Bubble className="text-xs">{labels[c.category] ?? c.category}</Bubble> : null}
            </div>
            <h3 className="text-lg font-bold text-heading">
              <Link href={c.href} className="text-heading no-underline after:absolute after:inset-0 hover:underline">
                {c.title}
              </Link>
            </h3>
            {c.description ? <p className="text-sm text-muted">{c.description}</p> : null}
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1 text-sm">
              {c.ageNote ? <span className="rounded-full bg-surface-muted px-3 py-1 font-semibold text-brand-800">{c.ageNote}</span> : <span />}
              <span className="font-semibold">{c.price}</span>
            </div>
            <span className="sr-only">{moreLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
