# Дизайн-система Okuspace (этап 4)

Источник истины: токены в [`src/app/globals.css`](../../src/app/globals.css) и компоненты в [`src/components/ui`](../../src/components/ui). В компонентах используются только токены — «сырые» цвета Tailwind (`gray-*`, `red-*`…) запрещены.

## 1. Цвета и контраст (WCAG 2.2 AA)

| Токен | Значение | Пара | Контраст |
|---|---|---|---|
| `ink` / `surface` | #111827 / #ffffff | основной текст | 17.7 : 1 |
| `muted` | #4b5563 | вторичный текст на белом | 7.6 : 1 |
| `brand-700` | #0f766e | ссылки; белый текст на кнопке | 5.5 : 1 |
| `brand-800` | #115e59 | hover кнопки, текст на `brand-50` | 7.2 : 1 |
| `danger-700` | #b91c1c | ошибки на `danger-50` | 5.9 : 1 |
| `success-800` | #166534 | успех на `success-50` | 6.8 : 1 |
| `warning-800` | #92400e | предупреждение на `warning-50` | 6.9 : 1 |

`brand-600` (#0d9488) — **только для декора**, не для фона под белым текстом (3.7 : 1). Это правило появилось после того, как axe нашёл такую кнопку в состоянии hover (см. STAGE_4.md).

## 2. Типографика, отступы, размеры

- Системный шрифт (без загрузки внешних шрифтов), базовый размер — 16 px, межстрочный интервал — 1.6.
- Заголовки: `h1` — 2.25–3 rem (одна штука на странице), `h2` — 1.5 rem, `h3` — 1.125 rem.
- Поля страницы задаёт `.container-page`: 16 px на телефоне, 24 px от `sm`, ширина не больше `max-w-6xl`.
- Цель нажатия ≥ 44 × 44 px (`min-h-11`). Радиусы: `--radius-control` (8 px), `--radius-card` (12 px).
- `prefers-reduced-motion` отключает анимации.

## 3. Компоненты

| Компонент | Файл | Доступность |
|---|---|---|
| `Button`, `ButtonLink`, `buttonClasses` | `ui/button.tsx` | варианты primary / secondary / danger / ghost, размеры md / lg |
| `SubmitButton` | `ui/submit-button.tsx` | блокируется на время отправки (нет двойной отправки) |
| `Field`, `SelectField`, `TextareaField`, `CheckboxField` | `ui/field.tsx`, `ui/controls.tsx` | `<label for>`, подсказка и ошибки через `aria-describedby`, `aria-invalid`; `idPrefix` — уникальные id при нескольких формах на странице |
| `FormMessage` | `ui/form-message.tsx` | ошибка — `role="alert"`, успех — `role="status"` |
| `Notice`, `EmptyState`, `Badge`, `Card`, `Skeleton`, `PageHeader` | `ui/notice.tsx` | `Notice live` объявляет только динамические сообщения |
| `ConfirmSubmit` | `ui/confirm-dialog.tsx` | нативный `<dialog>`: фокус внутрь, Esc закрывает, фокус возвращается; подтверждение отправляет форму штатно |
| `RichText` | `ui/rich-text.tsx` | безопасный вывод текстов из БД без HTML (`##`, `-`, абзацы) |
| `SiteHeader`, `SiteFooter`, `MobileMenu` | `site-chrome.tsx`, `mobile-menu.tsx` | landmarks `banner` / `nav` / `contentinfo`, `aria-expanded`, Esc, skip-link |
| `CourseCard`, `PriceLabel` | `features/site/course-card.tsx` | вся карточка кликабельна через ссылку-заголовок |

## 4. Состояния

Каждый экран с данными показывает одно из четырёх состояний:

1. **Данные.**
2. **Пусто** (`EmptyState`) — «скоро появится», без выдуманного контента.
3. **Недоступно** (`Notice tone="warning"`) — БД или сеть недоступны.
4. **Ошибка страницы** — `[locale]/error.tsx` с повтором и digest для поддержки, без stack trace.

Загрузка показывается кнопками в состоянии ожидания и компонентом `Skeleton`. Маршрутный `loading.tsx` убран сознательно: он начинает стримить ответ до `notFound()`, и 404 превращается в 200 (найдено e2e-тестом).

## 5. Проверка

- **axe-core** (WCAG 2A/2AA/2.1AA/2.2AA) на 18 публичных страницах в трёх языках, на десктопе и телефоне, плюс состояние ошибки формы: нарушений serious и critical нет (`tests/e2e/a11y.spec.ts`).
- Отсутствие горизонтальной прокрутки на 375 px, клавиатура в мобильном меню, skip-link (`tests/e2e/site.spec.ts`, `smoke.spec.ts`).
- Ручная проверка экранным диктором (NVDA/VoiceOver) **не проводилась** — она в чек-листе перед запуском (этап 14).
