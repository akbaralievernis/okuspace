import type { ReactNode } from 'react';
import type { ICONS } from '@/server/public/content';

/** Логотип школы: файл из /brand/ (белая версия — фильтром на тёмном фоне) или название текстом. */
export function SiteLogo({ src, name, white = false, className = 'h-10' }: { src?: string | undefined; name: string; white?: boolean; className?: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element -- статичный файл со своего домена, размеры заданы
    return <img src={src} alt={name} width={620} height={263} className={`w-auto max-w-none shrink-0 ${className} ${white ? 'logo-white' : ''}`} decoding="async" />;
  }
  const [first, ...rest] = name.split('');
  return (
    <span className={`font-extrabold tracking-tight ${white ? 'text-white' : 'text-ink'}`}>
      <span className={white ? '' : 'text-brand-600'}>{first}</span>
      {rest.join('')}
    </span>
  );
}

const PATHS: Record<(typeof ICONS)[number] | 'whatsapp' | 'pin' | 'instagram', ReactNode> = {
  teacher: (
    <>
      <path d="M22 10 12 5 2 10l10 5 10-5Z" />
      <path d="M6 12v5c3 2 9 2 12 0v-5" />
    </>
  ),
  group: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14.2c2.8.4 5 2.8 5 5.8" />
    </>
  ),
  exam: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="m9 12 2 2 4-4M9 7h6" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />,
  certificate: (
    <>
      <circle cx="12" cy="9" r="5" />
      <path d="m9 13.5-1 7.5 4-2 4 2-1-7.5" />
    </>
  ),
  map: (
    <>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  book: <path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2V4ZM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7V4Z" />,
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" />
    </>
  ),
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3Z" />,
  whatsapp: (
    <>
      <path d="M3.5 20.5 5 16a8.5 8.5 0 1 1 3.2 3.1L3.5 20.5Z" />
      <path d="M9 9.5c.3 2.3 2.2 4.4 4.8 5 .6.1 1.4-.4 1.6-1l-1.6-.9-.9.8c-1-.4-1.9-1.3-2.3-2.3l.8-.9-.9-1.6c-.6.2-1.1.9-1 1.4Z" />
    </>
  ),
  instagram: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" />
    </>
  ),
};

/** Линейные иконки 2px (стиль Lucide), цвет — от текста. */
export function Icon({ name, className = 'size-6' }: { name: keyof typeof PATHS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  );
}

/** Плашка-«облачко» с хвостиком, как в постах школы. */
export function Bubble({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`bubble ${className}`}>{children}</span>;
}

/** Бирюзовая дуга и кольцо за фото человека; внутри — фото или заглушка. */
export function ArcPhoto({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`relative isolate ${className}`}>
      <div aria-hidden="true" className="brand-gradient absolute inset-x-[6%] bottom-0 -z-10 aspect-square rounded-full" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-[-4%] -z-20 aspect-square rounded-full border-[6px] border-mint-400/40" />
      {children}
    </div>
  );
}

/** Заглушка вместо фото: подпись, какое фото нужно (фото школы пока не загружены). */
export function PhotoPlaceholder({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center rounded-t-full border-2 border-dashed border-white/70 bg-white/20 px-8 pb-6 pt-16 text-center text-sm font-semibold text-white ${className}`}>
      {label}
    </div>
  );
}

/** Декоративный точечный узор в углу секции. */
export function DotGrid({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`dot-grid pointer-events-none absolute size-32 ${className}`} />;
}
