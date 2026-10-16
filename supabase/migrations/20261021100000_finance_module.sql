-- =============================================================================
-- Этап 9. Полный модуль финансов поверх ядра 0005 (счета, платежи, возвраты,
-- распределения).
--
--  * Прайс-листы и тарифы; строки счёта — сумма счёта считается сервером (БД).
--  * Скидки и корректировки (кредит/дебет) — заявка бухгалтера, утверждение
--    руководителем (finance.approve), не тем же человеком. Ничего не редактируется:
--    каждое изменение — отдельная связанная запись.
--  * «Освобождение» распределения (с причиной) — путь к возврату денег по оплаченному
--    счёту: кредит-нота → освобождение → возврат платежа.
--  * Расходы со сторно; финансовые периоды — закрытый месяц не принимает операций.
--  * Онлайн-платежи: журнал событий провайдера (повтор webhook не создаёт платёж),
--    платёж записывает только сервер (service role), без данных карт.
--  * История статусов счёта, отчёты по филиалам и задолженности.
-- =============================================================================

insert into public.permissions (code, description) values
  ('finance.approve', 'Утверждать скидки и корректировки, вести прайс-листы, закрывать финансовые периоды');
insert into public.role_permissions (role, permission) values
  ('org_director', 'finance.approve'), ('branch_manager', 'finance.approve');

-- ---------------------------------------------------------------------------
-- 1. Финансовые периоды (месяц школы в её часовом поясе)
-- ---------------------------------------------------------------------------
create table public.finance_periods (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  period_month    date not null check (extract(day from period_month) = 1),
  status          text not null default 'closed' check (status in ('open', 'closed')),
  reason          text check (length(btrim(reason)) between 3 and 500),
  changed_by      uuid not null references public.profiles (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint finance_periods_month_key unique (organization_id, period_month),
  -- Повторное открытие закрытого месяца — только с причиной.
  constraint finance_periods_reopen_check check (status = 'closed' or reason is not null)
);

create or replace function app.assert_period_open(p_org uuid, p_at timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
begin
  select date_trunc('month', p_at at time zone o.default_timezone)::date into v_month from public.organizations o where o.id = p_org;
  if exists (select 1 from public.finance_periods where organization_id = p_org and period_month = v_month and status = 'closed') then
    raise exception 'financial period % is closed', to_char(v_month, 'YYYY-MM') using errcode = '23514';
  end if;
end;
$$;

create trigger finance_periods_set_updated_at before update on public.finance_periods
  for each row execute function app.set_updated_at();
create trigger finance_periods_immutable before update on public.finance_periods
  for each row execute function app.forbid_column_change('organization_id', 'period_month');
create trigger finance_periods_no_delete before delete on public.finance_periods
  for each row execute function app.forbid_mutation();
create trigger finance_periods_audit after insert or update on public.finance_periods
  for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 2. Прайс-листы и тарифы (цена тарифа неизменна — новая цена = новый тариф)
-- ---------------------------------------------------------------------------
create table public.price_lists (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid,
  name            text not null check (length(btrim(name)) between 1 and 120),
  currency        char(3) not null default 'KGS' check (currency ~ '^[A-Z]{3}$'),
  valid_from      date not null,
  valid_to        date,
  status          text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_by      uuid not null references public.profiles (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint price_lists_branch_fkey foreign key (organization_id, branch_id) references public.branches (organization_id, id) on delete restrict,
  constraint price_lists_dates_check check (valid_to is null or valid_to >= valid_from),
  constraint price_lists_scope_key unique (organization_id, id)
);

create table public.tariffs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  price_list_id   uuid not null,
  course_id       uuid,
  name            text not null check (length(btrim(name)) between 1 and 120),
  unit            text not null check (unit in ('month', 'lesson', 'course', 'hour', 'package')),
  lessons         int check (lessons between 1 and 500),
  amount          numeric(14, 2) not null check (amount > 0),
  status          text not null default 'active' check (status in ('active', 'archived')),
  created_at      timestamptz not null default now(),
  constraint tariffs_price_list_fkey foreign key (organization_id, price_list_id) references public.price_lists (organization_id, id) on delete restrict,
  constraint tariffs_course_fkey foreign key (organization_id, course_id) references public.courses (organization_id, id) on delete restrict
);

create trigger price_lists_set_updated_at before update on public.price_lists
  for each row execute function app.set_updated_at();
create trigger price_lists_immutable before update on public.price_lists
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'currency', 'created_by');
create trigger tariffs_immutable before update on public.tariffs
  for each row execute function app.forbid_column_change('organization_id', 'price_list_id', 'course_id', 'unit', 'lessons', 'amount', 'name');
create trigger price_lists_no_delete before delete on public.price_lists for each row execute function app.forbid_mutation();
create trigger tariffs_no_delete before delete on public.tariffs for each row execute function app.forbid_mutation();
create trigger price_lists_audit after insert or update on public.price_lists for each row execute function app.audit_row();
create trigger tariffs_audit after insert or update on public.tariffs for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 3. Строки счёта; сумма черновика считается в БД
-- ---------------------------------------------------------------------------
create table public.invoice_lines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  invoice_id      uuid not null,
  tariff_id       uuid references public.tariffs (id) on delete restrict,
  description     text not null check (length(btrim(description)) between 1 and 300),
  quantity        numeric(10, 2) not null check (quantity > 0 and quantity <= 1000),
  unit_price      numeric(14, 2) not null check (unit_price >= 0),
  line_total      numeric(14, 2) generated always as (round(quantity * unit_price, 2)) stored,
  created_at      timestamptz not null default now(),
  constraint invoice_lines_invoice_fkey foreign key (organization_id, branch_id, invoice_id)
    references public.invoices (organization_id, branch_id, id) on delete restrict
);
create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

-- ---------------------------------------------------------------------------
-- 4. Скидки и корректировки
-- ---------------------------------------------------------------------------
create table public.invoice_adjustments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  invoice_id      uuid not null,
  -- discount — до выставления (уменьшает сумму счёта); credit/debit — после (кредит-/дебет-нота).
  kind            text not null check (kind in ('discount', 'credit', 'debit')),
  amount          numeric(14, 2) not null check (amount > 0),
  reason          text not null check (length(btrim(reason)) between 3 and 500),
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by    uuid not null references public.profiles (id) on delete restrict,
  decided_by      uuid references public.profiles (id) on delete restrict,
  decided_at      timestamptz,
  decision_note   text check (length(decision_note) <= 500),
  created_at      timestamptz not null default now(),
  constraint invoice_adjustments_invoice_fkey foreign key (organization_id, branch_id, invoice_id)
    references public.invoices (organization_id, branch_id, id) on delete restrict,
  constraint invoice_adjustments_decided_check check ((status = 'pending') = (decided_by is null) and (decided_by is null) = (decided_at is null)),
  -- Четыре глаза: утверждает не тот, кто запросил.
  constraint invoice_adjustments_four_eyes_check check (decided_by is distinct from requested_by)
);
create index invoice_adjustments_invoice_idx on public.invoice_adjustments (invoice_id);

-- ---------------------------------------------------------------------------
-- 5. Распределения: «освобождение» вместо удаления
-- ---------------------------------------------------------------------------
alter table public.payment_allocations
  add column kind text not null default 'allocate' check (kind in ('allocate', 'release')),
  add column reverses_allocation_id uuid references public.payment_allocations (id) on delete restrict,
  add column reason text check (length(btrim(reason)) between 3 and 500),
  alter column created_by drop not null,
  add constraint payment_allocations_release_check check ((kind = 'release') = (reverses_allocation_id is not null) and (kind = 'allocate' or reason is not null));

-- Платёж: источник — сотрудник или провайдер (системная запись без пользователя).
alter table public.payments
  add column source text not null default 'staff' check (source in ('staff', 'provider')),
  alter column created_by drop not null,
  add constraint payments_source_actor_check check ((source = 'staff') = (created_by is not null) and (source = 'staff' or provider is not null));

-- Нетто распределённого по счёту / из платежа.
create or replace function app.invoice_paid(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when kind = 'allocate' then amount else -amount end), 0) from public.payment_allocations where invoice_id = p_invoice;
$$;

create or replace function app.payment_used(p_payment uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(case when kind = 'allocate' then amount else -amount end) from public.payment_allocations where payment_id = p_payment), 0)
       + coalesce((select sum(amount) from public.payments where reverses_payment_id = p_payment), 0);
$$;

-- К оплате по счёту: сумма + утверждённые дебет-ноты − утверждённые кредит-ноты.
create or replace function app.invoice_due(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select i.total
       + coalesce((select sum(amount) from public.invoice_adjustments a where a.invoice_id = i.id and a.status = 'approved' and a.kind = 'debit'), 0)
       - coalesce((select sum(amount) from public.invoice_adjustments a where a.invoice_id = i.id and a.status = 'approved' and a.kind = 'credit'), 0)
  from public.invoices i where i.id = p_invoice;
$$;

-- Сумма черновика по строкам: Σ строк − утверждённые скидки.
create or replace function app.invoice_draft_total(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(line_total) from public.invoice_lines where invoice_id = p_invoice), 0)
       - coalesce((select sum(amount) from public.invoice_adjustments where invoice_id = p_invoice and kind = 'discount' and status = 'approved'), 0);
$$;

-- Распределение и освобождение (заменяет проверку 0005).
create or replace function app.check_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_orig    public.payment_allocations%rowtype;
  v_released numeric;
begin
  select * into v_payment from public.payments where id = new.payment_id for update;
  select * into v_invoice from public.invoices where id = new.invoice_id for update;
  perform app.assert_period_open(new.organization_id, now());
  if new.created_by is null and v_payment.source <> 'provider' then
    raise exception 'only provider payments are allocated by the system' using errcode = '23514';
  end if;

  if new.kind = 'release' then
    select * into v_orig from public.payment_allocations where id = new.reverses_allocation_id for update;
    if v_orig.id is null or v_orig.kind <> 'allocate' or v_orig.payment_id <> new.payment_id or v_orig.invoice_id <> new.invoice_id then
      raise exception 'release must reverse an allocation of the same payment and invoice' using errcode = '23514';
    end if;
    select coalesce(sum(amount), 0) into v_released from public.payment_allocations where reverses_allocation_id = v_orig.id;
    if v_released + new.amount > v_orig.amount then
      raise exception 'release exceeds the allocation' using errcode = '23514';
    end if;
    return new;
  end if;

  if v_payment.kind <> 'payment' then
    raise exception 'only payments can be allocated' using errcode = '23514';
  end if;
  if v_invoice.status <> 'issued' then
    raise exception 'payments can be allocated only to issued invoices' using errcode = '23514';
  end if;
  if v_payment.currency <> v_invoice.currency then
    raise exception 'currency mismatch' using errcode = '23514';
  end if;
  if app.payment_used(v_payment.id) + new.amount > v_payment.amount then
    raise exception 'allocation exceeds the available payment amount' using errcode = '23514';
  end if;
  if app.invoice_paid(v_invoice.id) + new.amount > app.invoice_due(v_invoice.id) then
    raise exception 'allocation exceeds the invoice total' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Возврат: не больше нераспределённого остатка (с учётом освобождений). Период открыт.
create or replace function app.check_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orig public.payments%rowtype;
begin
  perform app.assert_member(new.organization_id, new.payer_id);
  perform app.assert_period_open(new.organization_id, new.received_at);
  if new.kind = 'refund' then
    select * into v_orig from public.payments where id = new.reverses_payment_id for update;
    if v_orig.kind <> 'payment' or v_orig.organization_id <> new.organization_id
       or v_orig.payer_id <> new.payer_id or v_orig.currency <> new.currency then
      raise exception 'refund must reverse a payment of the same payer, organization and currency' using errcode = '23514';
    end if;
    if app.payment_used(v_orig.id) + new.amount > v_orig.amount then
      raise exception 'refund exceeds the unallocated remainder of the payment' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Остатки по счёту (заменяет представление 0005: те же столбцы + корректировки).
create or replace view public.invoice_balances
with (security_invoker = true)
as
select
  i.id as invoice_id,
  i.organization_id,
  i.branch_id,
  i.payer_id,
  i.currency,
  i.total,
  app.invoice_paid(i.id)::numeric(14, 2) as paid,
  (app.invoice_due(i.id) - app.invoice_paid(i.id))::numeric(14, 2) as outstanding,
  case
    when i.status <> 'issued' then i.status
    when app.invoice_paid(i.id) = 0 and app.invoice_due(i.id) > 0 then 'unpaid'
    when app.invoice_paid(i.id) < app.invoice_due(i.id) then 'partially_paid'
    else 'paid'
  end as payment_status,
  app.invoice_due(i.id)::numeric(14, 2) as due,
  i.due_on,
  i.status
from public.invoices i;

-- ---------------------------------------------------------------------------
-- 6. Правила счёта, строк и корректировок
-- ---------------------------------------------------------------------------
create or replace function app.guard_invoice_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices%rowtype;
  v_tariff  public.tariffs%rowtype;
  v_list    public.price_lists%rowtype;
begin
  select * into v_invoice from public.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if v_invoice.status <> 'draft' then
    raise exception 'lines can be changed only on a draft invoice' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.tariff_id is not null then
    select * into v_tariff from public.tariffs where id = new.tariff_id;
    select * into v_list from public.price_lists where id = v_tariff.price_list_id;
    if v_tariff.organization_id <> new.organization_id or v_tariff.status <> 'active' or v_list.status <> 'active'
       or v_list.currency <> v_invoice.currency or (v_list.branch_id is not null and v_list.branch_id <> new.branch_id) then
      raise exception 'tariff is not available for this invoice' using errcode = '23514';
    end if;
    -- Цена — из прайс-листа; отклонение оформляется скидкой с утверждением.
    new.unit_price := v_tariff.amount;
  end if;
  return new;
end;
$$;

create or replace function app.recalc_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update public.invoices set total = app.invoice_draft_total(v_invoice)
   where id = v_invoice and status = 'draft' and exists (select 1 from public.invoice_lines where invoice_id = v_invoice);
  return null;
end;
$$;

create trigger invoice_lines_guard before insert or update or delete on public.invoice_lines
  for each row execute function app.guard_invoice_line();
create trigger invoice_lines_recalc after insert or update or delete on public.invoice_lines
  for each row execute function app.recalc_invoice();
create trigger invoice_lines_audit after insert or update or delete on public.invoice_lines
  for each row execute function app.audit_row();

-- Счёт со строками: сумму считает БД; выставление — без неутверждённых скидок и в открытом периоде.
create or replace function app.check_invoice_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status = 'draft' and exists (select 1 from public.invoice_lines where invoice_id = new.id) then
    new.total := app.invoice_draft_total(new.id);
    if new.total < 0 then
      raise exception 'discounts exceed the invoice amount' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'issued' then
    if exists (select 1 from public.invoice_adjustments where invoice_id = new.id and status = 'pending') then
      raise exception 'invoice has pending discounts' using errcode = '23514';
    end if;
    perform app.assert_period_open(new.organization_id, now());
  end if;
  if tg_op = 'UPDATE' and old.status = 'issued' and new.status = 'void' then
    perform app.assert_period_open(new.organization_id, now());
    if app.invoice_paid(new.id) > 0 then
      raise exception 'invoice with allocated payments cannot be voided' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger invoices_totals before update on public.invoices
  for each row execute function app.check_invoice_totals();

create or replace function app.guard_adjustment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  select * into v_invoice from public.invoices where id = new.invoice_id for update;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'adjustment starts as pending' using errcode = '23514';
    end if;
    if new.kind = 'discount' and v_invoice.status <> 'draft' then
      raise exception 'discounts apply only to draft invoices' using errcode = '23514';
    end if;
    if new.kind in ('credit', 'debit') and v_invoice.status <> 'issued' then
      raise exception 'credit and debit notes apply only to issued invoices' using errcode = '23514';
    end if;
    perform app.assert_period_open(new.organization_id, now());
    return new;
  end if;

  -- Решение: один раз, только статус и отметка о решении.
  if old.status <> 'pending' then
    raise exception 'adjustment is already decided' using errcode = '23514';
  end if;
  if (new.invoice_id, new.kind, new.amount, new.reason, new.requested_by, new.created_at)
     is distinct from (old.invoice_id, old.kind, old.amount, old.reason, old.requested_by, old.created_at) then
    raise exception 'adjustment is immutable' using errcode = '42501';
  end if;
  if new.decided_by is distinct from auth.uid() and auth.uid() is not null then
    raise exception 'decision must be signed by the approver' using errcode = '42501';
  end if;
  perform app.assert_period_open(new.organization_id, now());
  if new.status = 'approved' then
    if new.kind = 'discount' and app.invoice_draft_total(new.invoice_id) - new.amount < 0 then
      raise exception 'discounts exceed the invoice amount' using errcode = '23514';
    end if;
    if new.kind = 'credit' and new.amount > app.invoice_due(new.invoice_id) - app.invoice_paid(new.invoice_id) then
      raise exception 'credit exceeds the unpaid amount; release allocations first' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.after_adjustment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'discount' and new.status = 'approved' then
    update public.invoices set total = app.invoice_draft_total(new.invoice_id) where id = new.invoice_id and status = 'draft';
  end if;
  return null;
end;
$$;

create trigger invoice_adjustments_guard before insert or update on public.invoice_adjustments
  for each row execute function app.guard_adjustment();
create trigger invoice_adjustments_after after update on public.invoice_adjustments
  for each row execute function app.after_adjustment();
create trigger invoice_adjustments_no_delete before delete on public.invoice_adjustments
  for each row execute function app.forbid_mutation();
create trigger invoice_adjustments_audit after insert or update on public.invoice_adjustments
  for each row execute function app.audit_row();

-- История статусов счёта.
create table public.invoice_status_history (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  branch_id       uuid not null,
  invoice_id      uuid not null references public.invoices (id) on delete restrict,
  from_status     text,
  to_status       text not null,
  reason          text,
  actor_id        uuid,
  created_at      timestamptz not null default now()
);
create index invoice_status_history_invoice_idx on public.invoice_status_history (invoice_id, id);

create or replace function app.log_invoice_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.invoice_status_history (organization_id, branch_id, invoice_id, from_status, to_status, reason, actor_id)
    values (new.organization_id, new.branch_id, new.id, case when tg_op = 'UPDATE' then old.status end, new.status,
            case when new.status = 'void' then new.void_reason end, auth.uid());
  end if;
  return null;
end;
$$;

create trigger invoices_status_history after insert or update on public.invoices
  for each row execute function app.log_invoice_status();
create trigger invoice_status_history_append_only before update or delete on public.invoice_status_history
  for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 7. Расходы (сторно вместо удаления)
-- ---------------------------------------------------------------------------
create table public.expenses (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  branch_id           uuid not null,
  category            text not null check (category in ('rent', 'salary', 'utilities', 'marketing', 'supplies', 'taxes', 'other')),
  amount              numeric(14, 2) not null check (amount > 0),
  currency            char(3) not null default 'KGS' check (currency ~ '^[A-Z]{3}$'),
  spent_on            date not null,
  description         text not null check (length(btrim(description)) between 1 and 500),
  vendor              text check (length(vendor) <= 200),
  document_ref        text check (length(document_ref) <= 100),
  reverses_expense_id uuid unique references public.expenses (id) on delete restrict,
  reason              text check (length(btrim(reason)) between 3 and 500),
  created_by          uuid not null references public.profiles (id) on delete restrict,
  created_at          timestamptz not null default now(),
  constraint expenses_branch_fkey foreign key (organization_id, branch_id) references public.branches (organization_id, id) on delete restrict,
  constraint expenses_reversal_check check (reverses_expense_id is null or reason is not null)
);
create index expenses_branch_date_idx on public.expenses (organization_id, branch_id, spent_on);

create or replace function app.check_expense()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orig public.expenses%rowtype;
begin
  perform app.assert_period_open(new.organization_id, (new.spent_on::timestamp) at time zone 'UTC' + interval '12 hours');
  if new.reverses_expense_id is not null then
    select * into v_orig from public.expenses where id = new.reverses_expense_id;
    if v_orig.reverses_expense_id is not null or (v_orig.organization_id, v_orig.branch_id, v_orig.category, v_orig.amount, v_orig.currency)
       is distinct from (new.organization_id, new.branch_id, new.category, new.amount, new.currency) then
      raise exception 'reversal must mirror the original expense' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger expenses_check before insert on public.expenses for each row execute function app.check_expense();
create trigger expenses_append_only before update or delete on public.expenses for each row execute function app.forbid_mutation();
create trigger expenses_no_truncate before truncate on public.expenses for each statement execute function app.forbid_mutation();
create trigger expenses_audit after insert on public.expenses for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 8. Онлайн-платежи: события провайдера
-- ---------------------------------------------------------------------------
create table public.payment_webhook_events (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  event_id       text not null check (length(event_id) between 1 and 200),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  outcome        text not null check (outcome in ('recorded', 'duplicate', 'rejected')),
  detail         text check (length(detail) <= 300),
  payment_id     uuid references public.payments (id) on delete restrict,
  received_at    timestamptz not null default now(),
  constraint payment_webhook_events_once_key unique (provider, event_id)
);
create trigger payment_webhook_events_append_only before update or delete on public.payment_webhook_events
  for each row execute function app.forbid_mutation();

/**
 * Платёж от провайдера (вызывает только сервер после проверки подписи webhook).
 * Повтор того же события (или той же операции провайдера) возвращает уже записанный платёж.
 * Сумма проверяется здесь: не больше двух знаков, совпадение валюты, счёт выставлен.
 * Распределяется не больше остатка счёта; излишек остаётся нераспределённым (к возврату).
 */
create or replace function public.record_provider_payment(
  p_provider text, p_event_id text, p_payload_sha256 text, p_invoice uuid, p_amount numeric, p_currency text, p_provider_ref text, p_paid_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.payment_webhook_events%rowtype;
  v_invoice  public.invoices%rowtype;
  v_payment  uuid;
  v_alloc    numeric;
begin
  select * into v_existing from public.payment_webhook_events where provider = p_provider and event_id = p_event_id;
  if v_existing.id is not null then
    return jsonb_build_object('outcome', 'duplicate', 'paymentId', v_existing.payment_id);
  end if;
  select id into v_payment from public.payments where provider = p_provider and provider_ref = p_provider_ref;
  if v_payment is not null then
    insert into public.payment_webhook_events (provider, event_id, payload_sha256, outcome, payment_id)
    values (p_provider, p_event_id, p_payload_sha256, 'duplicate', v_payment);
    return jsonb_build_object('outcome', 'duplicate', 'paymentId', v_payment);
  end if;

  select * into v_invoice from public.invoices where id = p_invoice for update;
  if v_invoice.id is null or v_invoice.status <> 'issued' or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2)
     or p_currency is distinct from v_invoice.currency then
    insert into public.payment_webhook_events (provider, event_id, payload_sha256, outcome, detail)
    values (p_provider, p_event_id, p_payload_sha256, 'rejected',
            case when v_invoice.id is null or v_invoice.status <> 'issued' then 'invoice not payable'
                 when p_currency is distinct from v_invoice.currency then 'currency mismatch' else 'invalid amount' end);
    return jsonb_build_object('outcome', 'rejected');
  end if;

  insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, provider, provider_ref, received_at, source)
  values (v_invoice.organization_id, v_invoice.branch_id, v_invoice.payer_id, 'payment', p_amount, p_currency, 'online', p_provider, p_provider_ref,
          coalesce(p_paid_at, now()), 'provider')
  returning id into v_payment;
  v_alloc := least(p_amount, app.invoice_due(v_invoice.id) - app.invoice_paid(v_invoice.id));
  if v_alloc > 0 then
    insert into public.payment_allocations (organization_id, branch_id, payment_id, invoice_id, amount)
    values (v_invoice.organization_id, v_invoice.branch_id, v_payment, v_invoice.id, v_alloc);
  end if;
  insert into public.payment_webhook_events (provider, event_id, payload_sha256, outcome, payment_id)
  values (p_provider, p_event_id, p_payload_sha256, 'recorded', v_payment);
  return jsonb_build_object('outcome', 'recorded', 'paymentId', v_payment, 'allocated', v_alloc);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Отчёты (только охват finance.read; суммы — numeric)
-- ---------------------------------------------------------------------------
create or replace function public.finance_report(p_org uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select default_timezone into v_tz from public.organizations where id = p_org;
  return coalesce((
    select jsonb_agg(row_data order by row_data ->> 'branch', row_data ->> 'currency')
    from (
      select jsonb_build_object(
        'branchId', b.id, 'branch', b.name, 'currency', cur.currency,
        'invoiced', (select coalesce(sum(app.invoice_due(i.id)), 0) from public.invoices i
                      where i.branch_id = b.id and i.currency = cur.currency and i.status = 'issued'
                        and (i.issued_at at time zone v_tz)::date between p_from and p_to)::numeric(14, 2)::text,
        'received', (select coalesce(sum(amount), 0) from public.payments p
                      where p.branch_id = b.id and p.currency = cur.currency and p.kind = 'payment'
                        and (p.received_at at time zone v_tz)::date between p_from and p_to)::numeric(14, 2)::text,
        'refunded', (select coalesce(sum(amount), 0) from public.payments p
                      where p.branch_id = b.id and p.currency = cur.currency and p.kind = 'refund'
                        and (p.received_at at time zone v_tz)::date between p_from and p_to)::numeric(14, 2)::text,
        'expenses', (select coalesce(sum(case when e.reverses_expense_id is null then e.amount else -e.amount end), 0) from public.expenses e
                      where e.branch_id = b.id and e.currency = cur.currency and e.spent_on between p_from and p_to)::numeric(14, 2)::text,
        'outstanding', (select coalesce(sum(greatest(app.invoice_due(i.id) - app.invoice_paid(i.id), 0)), 0) from public.invoices i
                         where i.branch_id = b.id and i.currency = cur.currency and i.status = 'issued')::numeric(14, 2)::text
      ) as row_data
      from public.branches b
      cross join (select distinct currency from (
                    select currency::text from public.invoices where organization_id = p_org
                    union select currency::text from public.payments where organization_id = p_org
                    union select currency::text from public.expenses where organization_id = p_org) c) cur
      where b.organization_id = p_org and app.has_permission(p_org, b.id, 'finance.read')
    ) r
  ), '[]'::jsonb);
end;
$$;

-- Должники: выставленные счета с остатком, по плательщикам (охват finance.read).
create or replace function public.finance_debts(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('payerId', payer_id, 'payer', payer, 'branch', branch, 'currency', currency,
                                               'invoices', n, 'outstanding', outstanding::numeric(14, 2)::text, 'oldestDueOn', oldest)
                            order by outstanding desc), '[]'::jsonb)
  from (
    select i.payer_id, nullif(p.full_name, '') as payer, b.name as branch, i.currency, count(*) as n,
           sum(app.invoice_due(i.id) - app.invoice_paid(i.id)) as outstanding, min(i.due_on) as oldest
      from public.invoices i
      join public.branches b on b.id = i.branch_id
      left join public.profiles p on p.id = i.payer_id
     where i.organization_id = p_org and i.status = 'issued'
       and app.has_permission(i.organization_id, i.branch_id, 'finance.read')
       and app.invoice_due(i.id) - app.invoice_paid(i.id) > 0
     group by i.payer_id, p.full_name, b.name, i.currency
  ) d;
$$;

-- ---------------------------------------------------------------------------
-- 10. RLS
-- ---------------------------------------------------------------------------
alter table public.finance_periods        enable row level security;
alter table public.price_lists            enable row level security;
alter table public.tariffs                enable row level security;
alter table public.invoice_lines          enable row level security;
alter table public.invoice_adjustments    enable row level security;
alter table public.invoice_status_history enable row level security;
alter table public.expenses               enable row level security;
alter table public.payment_webhook_events enable row level security;

create or replace function app.can_read_invoice(p_invoice uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.invoices i where i.id = p_invoice
                 and (i.payer_id = (select auth.uid()) or app.is_guardian_of(i.payer_id)
                      or app.has_permission(i.organization_id, i.branch_id, 'finance.read')));
$$;

create policy "finance readers see periods" on public.finance_periods
  for select to authenticated using (app.has_permission(organization_id, null, 'finance.read') or exists (
    select 1 from public.branches b where b.organization_id = finance_periods.organization_id and app.has_permission(b.organization_id, b.id, 'finance.read')));
create policy "approvers with mfa close periods" on public.finance_periods
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'finance.approve') and changed_by = (select auth.uid()));
create policy "approvers with mfa reopen periods" on public.finance_periods
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'finance.approve'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'finance.approve') and changed_by = (select auth.uid()));

create policy "finance and sales staff see price lists" on public.price_lists
  for select to authenticated using (app.has_permission(organization_id, branch_id, 'finance.read') or app.has_permission(organization_id, branch_id, 'lead.read'));
create policy "approvers with mfa create price lists" on public.price_lists
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.approve') and created_by = (select auth.uid()));
create policy "approvers with mfa change price lists" on public.price_lists
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.approve'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.approve'));

create policy "finance and sales staff see tariffs" on public.tariffs
  for select to authenticated using (exists (select 1 from public.price_lists l where l.id = price_list_id));
create policy "approvers with mfa add tariffs" on public.tariffs
  for insert to authenticated with check (app.current_aal() = 'aal2' and exists (
    select 1 from public.price_lists l where l.id = price_list_id and app.has_permission(l.organization_id, l.branch_id, 'finance.approve')));
create policy "approvers with mfa archive tariffs" on public.tariffs
  for update to authenticated
  using (app.current_aal() = 'aal2' and exists (select 1 from public.price_lists l where l.id = price_list_id and app.has_permission(l.organization_id, l.branch_id, 'finance.approve')))
  with check (app.current_aal() = 'aal2');

create policy "invoice readers see lines" on public.invoice_lines
  for select to authenticated using (app.can_read_invoice(invoice_id));
create policy "finance writers with mfa edit lines" on public.invoice_lines
  for all to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.write'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.write'));

create policy "invoice readers see adjustments" on public.invoice_adjustments
  for select to authenticated using (app.can_read_invoice(invoice_id));
create policy "finance writers with mfa request adjustments" on public.invoice_adjustments
  for insert to authenticated with check (
    app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.write') and requested_by = (select auth.uid()) and status = 'pending'
  );
create policy "approvers with mfa decide adjustments" on public.invoice_adjustments
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.approve'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.approve') and decided_by = (select auth.uid()));

create policy "invoice readers see status history" on public.invoice_status_history
  for select to authenticated using (app.can_read_invoice(invoice_id));

create policy "finance readers see expenses" on public.expenses
  for select to authenticated using (app.has_permission(organization_id, branch_id, 'finance.read'));
create policy "finance writers with mfa record expenses" on public.expenses
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.write') and created_by = (select auth.uid()));
-- payment_webhook_events: без политик — только service role.

-- Освобождение распределения — право возвратов (finance.refund), обычное распределение — finance.write.
drop policy "finance writers with mfa can allocate payments" on public.payment_allocations;
create policy "finance staff with mfa allocate and release payments" on public.payment_allocations
  for insert to authenticated with check (
    app.current_aal() = 'aal2' and created_by = (select auth.uid())
    and case kind
      when 'allocate' then app.has_permission(organization_id, branch_id, 'finance.write')
      when 'release' then app.has_permission(organization_id, branch_id, 'finance.refund')
      else false
    end
  );

-- ---------------------------------------------------------------------------
-- 11. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.finance_periods, public.price_lists, public.tariffs, public.invoice_lines, public.invoice_adjustments,
  public.invoice_status_history, public.expenses, public.payment_webhook_events from anon, authenticated;
grant select, insert on public.finance_periods, public.price_lists, public.tariffs, public.invoice_adjustments, public.expenses to authenticated;
grant update (status, reason, changed_by) on public.finance_periods to authenticated;
grant update (name, valid_from, valid_to, status) on public.price_lists to authenticated;
grant update (status) on public.tariffs to authenticated;
grant update (status, decided_by, decided_at, decision_note) on public.invoice_adjustments to authenticated;
grant select, insert, update, delete on public.invoice_lines to authenticated;
grant select on public.invoice_status_history to authenticated;
grant all on public.finance_periods, public.price_lists, public.tariffs, public.invoice_lines, public.invoice_adjustments,
  public.invoice_status_history, public.expenses, public.payment_webhook_events to service_role;
revoke all on public.invoice_balances from anon, authenticated;
grant select on public.invoice_balances to authenticated, service_role;

revoke all on function public.record_provider_payment(text, text, text, uuid, numeric, text, text, timestamptz),
  public.finance_report(uuid, date, date), public.finance_debts(uuid) from public, anon;
grant execute on function public.record_provider_payment(text, text, text, uuid, numeric, text, text, timestamptz) to service_role;
grant execute on function public.finance_report(uuid, date, date), public.finance_debts(uuid) to authenticated, service_role;

grant execute on function app.invoice_paid(uuid), app.invoice_due(uuid), app.payment_used(uuid), app.invoice_draft_total(uuid),
  app.can_read_invoice(uuid) to authenticated, service_role;

revoke execute on all functions in schema app from public, anon;
