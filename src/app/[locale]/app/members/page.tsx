import { notFound } from 'next/navigation';
import { AppHeader, appNav } from '@/components/app-header';
import { InviteForm, MemberStatusForm, type InviteScope } from '@/features/members/forms';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { assignableRoles, can, canAssignRole } from '@/server/authz/check';
import { requireAccess } from '@/server/auth/session';
import { branchesOf, visibleMemberships } from '@/server/queries/workspace';

export default async function MembersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/members`);
  const t = getDictionary(locale);
  const mine = ctx.memberships;

  const canRead = mine.some((m) => can(mine, 'member.read', m.organizationId, m.branchId));
  if (!canRead) {
    return (
      <>
        <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
        <main id="main" className="mx-auto max-w-5xl px-4 py-8">
          <h1 className="text-2xl font-bold">{t.app.members.title}</h1>
          <p className="mt-4">{t.app.members.noRights}</p>
        </main>
      </>
    );
  }

  const orgIds = [...new Set(mine.map((m) => m.organizationId))];
  const [members, branches] = await Promise.all([visibleMemberships(), branchesOf(orgIds)]);
  const orgName = new Map(members.map((m) => [m.organizationId, m.organizationName]));

  // Охваты для приглашения: вся школа (если есть организационная роль) и каждый филиал.
  const scopes: InviteScope[] = [];
  for (const orgId of orgIds) {
    const orgRoles = assignableRoles(mine, orgId, null).filter((r) => ['sales_manager', 'accountant'].includes(r));
    if (orgRoles.length) scopes.push({ organizationId: orgId, organizationName: orgName.get(orgId) ?? '—', branchId: null, branchName: null, roles: orgRoles });
    for (const b of branches.filter((x) => x.organizationId === orgId)) {
      const roles = assignableRoles(mine, orgId, b.id);
      if (roles.length) scopes.push({ organizationId: orgId, organizationName: orgName.get(orgId) ?? '—', branchId: b.id, branchName: b.name, roles });
    }
  }

  return (
    <>
      <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
      <main id="main" className="mx-auto max-w-5xl space-y-10 px-4 py-8">
        <h1 className="text-2xl font-bold">{t.app.members.title}</h1>

        {scopes.length > 0 ? (
          <section aria-labelledby="invite-h" className="max-w-md space-y-3">
            <h2 id="invite-h" className="text-lg font-semibold">{t.app.members.inviteTitle}</h2>
            <InviteForm locale={locale} scopes={scopes} t={t} pending={t.common.pending} />
          </section>
        ) : null}

        <section aria-labelledby="list-h" className="space-y-3">
          <h2 id="list-h" className="text-lg font-semibold">{t.app.members.title}</h2>
          {members.length === 0 ? (
            <p>{t.app.members.empty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pr-3">{t.app.members.person}</th>
                    <th scope="col" className="py-2 pr-3">{t.app.role}</th>
                    <th scope="col" className="py-2 pr-3">{t.app.branch}</th>
                    <th scope="col" className="py-2 pr-3">{t.app.members.status}</th>
                    <th scope="col" className="py-2">{t.app.members.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => {
                    const self = m.profileId === ctx.user.id;
                    const manageable = !self && canAssignRole(mine, m.role, m.organizationId, m.branchId);
                    return (
                      <tr key={m.id} className="border-b border-border align-top">
                        <td className="py-2 pr-3">
                          {m.fullName}
                          {self ? ` (${t.app.members.self})` : ''}
                        </td>
                        <td className="py-2 pr-3">{t.roles[m.role]}</td>
                        <td className="py-2 pr-3">{m.branchName ?? t.app.wholeOrganization}</td>
                        <td className="py-2 pr-3">{t.memberStatus[m.status]}</td>
                        <td className="space-y-2 py-2">
                          {manageable && m.status === 'active' ? (
                            <>
                              <MemberStatusForm locale={locale} membershipId={m.id} target="blocked" name={m.fullName} t={t} pending={t.common.pending} />
                              <MemberStatusForm locale={locale} membershipId={m.id} target="revoked" name={m.fullName} t={t} pending={t.common.pending} />
                            </>
                          ) : null}
                          {manageable && m.status === 'blocked' ? (
                            <MemberStatusForm locale={locale} membershipId={m.id} target="active" name={m.fullName} t={t} pending={t.common.pending} />
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
