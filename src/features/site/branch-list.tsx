import { Card } from '@/components/ui/notice';
import type { Site } from '@/server/public/schemas';

/** Список филиалов с адресом, телефоном и email (только опубликованные поля). */
export function BranchList({ branches, labels }: { branches: Site['branches']; labels: { phone: string; email: string; address: string } }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {branches.map((b) => (
        <li key={b.id}>
          <Card>
            <h2 className="text-lg font-semibold">
              {b.city} — {b.name}
            </h2>
            <dl className="mt-2 space-y-1 text-sm">
              {b.address ? (
                <div>
                  <dt className="inline font-medium">{labels.address}: </dt>
                  <dd className="inline">{b.address}</dd>
                </div>
              ) : null}
              {b.phone ? (
                <div>
                  <dt className="inline font-medium">{labels.phone}: </dt>
                  <dd className="inline">
                    <a className="link" href={`tel:${b.phone.replace(/[^+\d]/g, '')}`}>
                      {b.phone}
                    </a>
                  </dd>
                </div>
              ) : null}
              {b.email ? (
                <div>
                  <dt className="inline font-medium">{labels.email}: </dt>
                  <dd className="inline">
                    <a className="link" href={`mailto:${b.email}`}>
                      {b.email}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
          </Card>
        </li>
      ))}
    </ul>
  );
}
