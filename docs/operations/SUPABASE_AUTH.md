# Настройка Supabase Auth (обязательно до staging)

Без этих настроек код этапа 3 работает неверно или небезопасно. Каждый пункт проверяется на тестовом проекте Supabase прогоном из §4.

## 1. Authentication → Providers → Email

| Настройка | Значение | Зачем |
|---|---|---|
| Enable Email provider | ✅ | вход по email и паролю |
| Confirm email | ✅ | без подтверждения сессия не выдаётся |
| Secure email change | ✅ | смену email подтверждают оба адреса |
| Secure password change | ✅ | смена пароля требует недавнего входа |
| Minimum password length | **10** | совпадает с `PASSWORD_MIN` в `src/lib/auth/schemas.ts` |
| Leaked password protection | ✅ (если доступно на тарифе) | запрет паролей из утечек |

## 2. Authentication → URL Configuration

- **Site URL:** адрес окружения (`https://<домен>`).
- **Redirect URLs:** только `https://<домен>/ky/**`, `https://<домен>/ru/**`, `https://<домен>/en/**`. Без `*` на чужие домены.

## 3. Authentication → Email Templates

Ссылки в письмах ведут на обработчик `/{locale}/auth/confirm` с `token_hash`, а не на `{{ .ConfirmationURL }}`. Так ссылка работает при открытии на другом устройстве и не зависит от PKCE-cookie.

| Шаблон | Ссылка |
|---|---|
| Confirm signup | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` |
| Reset password | `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery` |
| Change email address | `{{ .SiteURL }}/ru/auth/confirm?token_hash={{ .TokenHash }}&type=email_change` |

`RedirectTo` формирует сервер:

- при регистрации — `…/{locale}/auth/confirm`;
- при восстановлении — `…/{locale}/auth/confirm?next=/{locale}/reset-password`. Поэтому в шаблоне восстановления стоит `&`.

Тексты писем — на трёх языках (этап 4/11).

## 4. Authentication → Multi-Factor

- **TOTP:** enabled (enroll + verify).
- **Maximum factors per user:** 10. Каждая попытка подключения создаёт неподтверждённый фактор.

## 5. Сессии и лимиты

- **JWT expiry:** 3600 с (по умолчанию).
- **Rate limits** (Authentication → Rate Limits): не мягче значений Supabase по умолчанию. Собственные лимиты приложения — в `LIMITS` (`src/server/auth/use-cases.ts`) и таблице `rate_limits`.
- **Time-box / inactivity timeout** (на платных тарифах): 30 дней / 7 дней.

## 6. Переменные окружения приложения

| Переменная | Где | Комментарий |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Vercel, все окружения | базовый URL для ссылок в письмах и приглашениях |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel | публичные |
| `SUPABASE_SECRET_KEY` | Vercel, **только серверная** | нужен rate limiter. Без него вход и регистрация отвечают «сервис недоступен» (fail closed) |

## 7. Проверка на тестовом проекте (шлюз перед staging)

1. Применить миграции `supabase/migrations/*` и прогнать `tests/security` против этой БД (ADR-0004).
2. Вручную или Playwright-сценарием проверить:
   - регистрацию → письмо → подтверждение → вход;
   - неверный пароль ×6 → блокировка по лимиту;
   - восстановление пароля → новая ссылка → смена → старые сеансы завершены;
   - подключение TOTP → выход → вход требует код;
   - приглашение: создание ссылки → вход приглашённым → роль появилась → повторное открытие ссылки отклонено;
   - блокировка сотрудника → его следующий запрос не видит данных школы.
3. Проверить, что у роли `postgres` есть `SELECT` на `auth.sessions` (используется в `list_my_sessions`).
