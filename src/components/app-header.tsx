import Link from 'next/link';
import { Suspense } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { logoutAction } from '@/server/auth/actions';
import type { AccessContext } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import type { Permission } from '@/server/authz/permissions';

export interface AppNavItem {
  href: string;
  label: string;
}

/** Пункты меню кабинета — только разделы, к которым у пользователя реально есть доступ. */
export function appNav(ctx: AccessContext, locale: Locale, t: Dictionary): AppNavItem[] {
  const m = ctx.memberships;
  const anyScope = (p: Permission) => m.some((x) => can(m, p, x.organizationId, x.branchId));
  const orgScope = (p: Permission) => m.some((x) => can(m, p, x.organizationId, null));
  const href = (path: string) => `/${locale}/app${path}`;
  const role = (r: string) => m.some((x) => x.role === r && x.status === 'active');
  const items: AppNavItem[] = [{ href: href(''), label: t.nav.workspace }];
  if (anyScope('dashboard.read')) items.push({ href: href('/dashboard'), label: t.mgmt.nav.dashboard });
  if (m.some((x) => x.status === 'active' && !['student', 'parent'].includes(x.role))) items.push({ href: href('/tasks'), label: t.mgmt.nav.tasks });
  if (m.some((x) => x.status === 'active')) items.push({ href: href('/announcements'), label: t.mgmt.nav.announcements });
  if (m.some((x) => x.status === 'active')) items.push({ href: href('/schedule'), label: t.schedule.nav });
  if (m.some((x) => x.status === 'active')) items.push({ href: href('/ai'), label: t.ai.nav });
  if (role('student') || role('parent')) items.push({ href: href('/learn'), label: t.lms.nav.learn });
  if (role('teacher') || orgScope('catalog.manage')) items.push({ href: href('/courses'), label: t.lms.nav.courses });
  if (role('teacher') || anyScope('group.read')) items.push({ href: href('/groups'), label: t.lms.nav.groups });
  if (orgScope('catalog.manage')) items.push({ href: href('/catalog'), label: t.lms.nav.catalog });
  if (anyScope('member.read')) items.push({ href: href('/members'), label: t.nav.members });
  if (anyScope('lead.read')) items.push({ href: href('/crm'), label: t.crm.nav });
  if (anyScope('finance.read')) items.push({ href: href('/finance'), label: t.finance.nav });
  if (anyScope('monitoring.view')) items.push({ href: href('/monitoring'), label: t.monitoring.nav });
  if (role('student') || role('parent')) items.push({ href: href('/billing'), label: t.finance.billingNav });
  if (anyScope('lead.read')) items.push({ href: href('/requests'), label: t.admin.nav.requests });
  if (anyScope('schedule.manage')) items.push({ href: href('/trials'), label: t.admin.nav.trials });
  if (orgScope('site.manage')) items.push({ href: href('/site'), label: t.admin.nav.site });
  if (role('teacher')) items.push({ href: href('/profile'), label: t.admin.nav.publicProfile });
  if (role('teacher') && !anyScope('finance.read')) items.push({ href: href('/payroll'), label: t.auto.nav.payroll });
  if (m.some((x) => x.status === 'active')) items.push({ href: href('/notifications'), label: t.schedule.navNotifications });
  items.push({ href: href('/account'), label: t.nav.account });
  return items;
}

/** Шапка кабинета. */
export function AppHeader({ locale, t, items }: { locale: Locale; t: Dictionary; items: AppNavItem[] }) {
  const link = 'inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-3 text-ink no-underline hover:bg-surface-muted';
  return (
    <header className="border-b border-border">
      <div className="container-page flex flex-wrap items-center justify-between gap-2 py-2">
        <nav aria-label={t.nav.main} className="flex flex-wrap items-center gap-1">
          <Link href={`/${locale}`} className="mr-2 font-bold text-ink no-underline">
            Okuspace
          </Link>
          {items.map((item) => (
            <Link key={item.href} href={item.href} className={link}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <Suspense>
            <LanguageSwitcher current={locale} label={t.languageSwitcher.label} />
          </Suspense>
          <form action={logoutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-border-strong px-3 hover:bg-surface-muted">
              {t.nav.signOut}
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
