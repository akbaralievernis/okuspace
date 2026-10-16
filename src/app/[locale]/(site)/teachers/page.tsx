import { notFound } from 'next/navigation';
import { Badge, Card, EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getTeachers } from '@/server/public/site';

export default async function TeachersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const p = t.site.teachers;
  const teachers = await getTeachers();

  return (
    <>
      <PageHeader title={p.title} lead={p.lead} />
      {!teachers.ok ? (
        <Notice tone="warning">{t.site.unavailable}</Notice>
      ) : teachers.data.length === 0 ? (
        <EmptyState title={p.empty} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {teachers.data.map((teacher) => {
            // Описание на языке интерфейса, иначе — на любом доступном.
            const bio = teacher.bio[locale] ?? teacher.bio.ru ?? teacher.bio.en ?? teacher.bio.ky;
            return (
              <li key={teacher.displayName}>
                <Card className="space-y-2">
                  <h2 className="text-lg font-semibold">{teacher.displayName}</h2>
                  {teacher.languages.length ? (
                    <div className="flex flex-wrap gap-2">
                      {teacher.languages.map((l) => (
                        <Badge key={l} tone="brand">
                          {l.toUpperCase()}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {bio ? <RichText text={bio} /> : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
