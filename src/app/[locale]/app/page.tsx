import { notFound } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { can } from '@/server/authz/check';
import { requireAccess } from '@/server/auth/session';
import { visibleMemberships } from '@/server/queries/workspace';

export default async function WorkspacePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app`);
  const t = getDictionary(locale);
  const mine = await visibleMemberships({ profileId: ctx.user.id });
  const showMembers = ctx.memberships.some((m) => can(ctx.memberships, 'member.read', m.organizationId, m.branchId));

  return (
    <>
      <AppHeader locale={locale} t={t} showMembers={showMembers} />
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-bold">{t.app.title}</h1>
        <p className="mt-1 text-muted">{fmt(t.app.greeting, { email: ctx.user.email ?? '' })}</p>

        <h2 className="mt-8 text-lg font-semibold">{t.app.membershipsTitle}</h2>
        {mine.filter((m) => m.status === 'active').length === 0 ? (
          <p className="mt-2">{t.app.noMemberships}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-300">
                  <th scope="col" className="py-2 pr-4">{t.app.organization}</th>
                  <th scope="col" className="py-2 pr-4">{t.app.branch}</th>
                  <th scope="col" className="py-2">{t.app.role}</th>
                </tr>
              </thead>
              <tbody>
                {mine
                  .filter((m) => m.status === 'active')
                  .map((m) => (
                    <tr key={m.id} className="border-b border-gray-200">
                      <td className="py-2 pr-4">{m.organizationName}</td>
                      <td className="py-2 pr-4">{m.branchName ?? t.app.wholeOrganization}</td>
                      <td className="py-2">{t.roles[m.role]}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
