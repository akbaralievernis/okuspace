# Okuspace Next

Платформа управления языковой школой с несколькими филиалами: обучение, расписание, посещаемость, CRM, финансы, AI Language Lab.

> Статус: **этап 1 — архитектура и фундамент.** Бизнес-функций пока нет.
> План: [docs/ROADMAP.md](docs/ROADMAP.md) · Решения: [docs/DECISIONS.md](docs/DECISIONS.md) · Архитектура: [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)

## Стек

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · Zod 4 · Supabase (Postgres, Auth, Storage, RLS) · Vitest · Playwright.

## Запуск

Требуется Node.js 24+.

```bash
npm ci
```

```bash
cp .env.example .env.local
```

```bash
npm run dev
```

Главная страница без Supabase работает. Переменные Supabase понадобятся с этапа 2.

## Проверки

| Команда | Что делает |
|---|---|
| `npm run typecheck` | `tsc --noEmit` в strict-режиме |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript), 0 предупреждений |
| `npm run test` | unit-тесты Vitest |
| `npm run build` | production-сборка |
| `npm run check:bundle` | поиск серверных секретов в клиентской сборке |
| `npm run test:e2e` | Playwright против production-сборки (нужен `npx playwright install chromium`) |
| `npm run verify` | всё перечисленное по порядку |

## Структура

См. [ARCHITECTURE.md §4](docs/architecture/ARCHITECTURE.md). Кратко: `src/app` — маршруты, `src/server` — только серверный код (`server-only`), `src/lib` — чистые утилиты, `src/i18n` — словари ky/ru/en, `tests/{unit,e2e}`.

## Старый проект

Прежний PHP-портал удалён из этой папки (ADR-0001). Полная копия: `Desktop/okuspace-htdocs-backup-2026-10-15.zip`. Живой сайт okuspace.rf.gd деплоится из отдельного репозитория `Desktop/okuspace`.
