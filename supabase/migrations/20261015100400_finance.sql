-- ============================================================================
-- 0005 · Финансовое ядро: счета, платежи, возвраты, распределения.
-- Деньги — numeric(14,2) + ISO 4217. Платежи и распределения — append-only:
-- исправления оформляются возвратом/новой записью, а не UPDATE.
-- Модель: docs/architecture/DATA_MODEL.md §4. Полный модуль финансов — этап 9.
-- ============================================================================

create table public.invoices (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  payer_id        uuid not null references public.profiles (id) on delete restrict,
  number          text not null check (number ~ '^[A-Za-z0-9/._-]{1,40}$'),
  currency        char(3) not null default 'KGS' check (currency ~ '^[A-Z]{3}$'),
  total           numeric(14, 2) not null check (total >= 0),
  status          text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  description     text check (length(description) <= 2000),
  due_on          date,
  issued_at       timestamptz,
  void_reason     text check (length(void_reason) <= 500),
  created_by      uuid not null references public.profiles (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint invoices_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint invoices_number_key unique (organization_id, number),
  constraint invoices_scope_id_key unique (organization_id, branch_id, id),
  constraint invoices_issued_check check (status = 'draft' or issued_at is not null or status = 'void'),
  constraint invoices_void_check check (status <> 'void' or void_reason is not null)
);
create index invoices_payer_idx on public.invoices (payer_id);

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  branch_id           uuid not null,
  payer_id            uuid not null references public.profiles (id) on delete restrict,
  kind                text not null check (kind in ('payment', 'refund')),
  amount              numeric(14, 2) not null check (amount > 0),
  currency            char(3) not null check (currency ~ '^[A-Z]{3}$'),
  method              text not null check (method in ('cash', 'card', 'bank_transfer', 'online')),
  reverses_payment_id uuid references public.payments (id) on delete restrict,
  reason              text check (length(reason) <= 1000),
  provider            text check (provider ~ '^[a-z0-9_]{2,40}$'),
  provider_ref        text check (length(provider_ref) between 1 and 200),
  received_at         timestamptz not null default now(),
  created_by          uuid not null references public.profiles (id) on delete restrict,
  created_at          timestamptz not null default now(),
  constraint payments_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint payments_scope_id_key unique (organization_id, branch_id, id),
  -- Возврат всегда ссылается на исходный платёж и имеет причину.
  constraint payments_refund_link_check check ((kind = 'refund') = (reverses_payment_id is not null)),
  constraint payments_refund_reason_check check (kind <> 'refund' or coalesce(length(btrim(reason)), 0) > 0),
  constraint payments_provider_pair_check check ((provider is null) = (provider_ref is null)),
  -- Одна операция провайдера = одна запись (защита от повторного webhook).
  constraint payments_provider_ref_key unique (provider, provider_ref)
);
create index payments_payer_idx on public.payments (payer_id);
create index payments_reverses_idx on public.payments (reverses_payment_id) where reverses_payment_id is not null;

create table public.payment_allocations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  payment_id      uuid not null,
  invoice_id      uuid not null,
  amount          numeric(14, 2) not null check (amount > 0),
  created_by      uuid not null references public.profiles (id) on delete restrict,
  created_at      timestamptz not null default now(),
  constraint payment_allocations_payment_fkey foreign key (organization_id, branch_id, payment_id)
    references public.payments (organization_id, branch_id, id) on delete restrict,
  constraint payment_allocations_invoice_fkey foreign key (organization_id, branch_id, invoice_id)
    references public.invoices (organization_id, branch_id, id) on delete restrict
);
create index payment_allocations_payment_idx on public.payment_allocations (payment_id);
create index payment_allocations_invoice_idx on public.payment_allocations (invoice_id);

-- ---------------------------------------------------------------------------
-- Целостность
-- ---------------------------------------------------------------------------

-- Счёт: черновик редактируется; выставленный — только аннулируется; аннулированный неизменен.
create or replace function app.guard_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.assert_member(new.organization_id, new.payer_id);
    if new.status = 'issued' then
      new.issued_at := coalesce(new.issued_at, now());
    end if;
    return new;
  end if;

  if old.status = 'void' then
    raise exception 'void invoice is immutable' using errcode = '42501';
  end if;

  if old.status = 'issued' then
    if new.status <> 'void'
       or (to_jsonb(new) - array['status', 'void_reason', 'updated_at'])
          is distinct from (to_jsonb(old) - array['status', 'void_reason', 'updated_at']) then
      raise exception 'issued invoice can only be voided' using errcode = '42501';
    end if;
    if exists (select 1 from public.payment_allocations where invoice_id = old.id) then
      raise exception 'invoice with allocated payments cannot be voided' using errcode = '23514';
    end if;
    return new;
  end if;

  -- draft
  if new.status = 'issued' then
    new.issued_at := now();
  end if;
  return new;
end;
$$;

-- Возврат: тот же плательщик, организация и валюта; не больше нераспределённого остатка.
create or replace function app.check_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orig      public.payments%rowtype;
  v_refunded  numeric;
  v_allocated numeric;
begin
  perform app.assert_member(new.organization_id, new.payer_id);

  if new.kind = 'refund' then
    select * into v_orig from public.payments where id = new.reverses_payment_id for update;
    if v_orig.kind <> 'payment' or v_orig.organization_id <> new.organization_id
       or v_orig.payer_id <> new.payer_id or v_orig.currency <> new.currency then
      raise exception 'refund must reverse a payment of the same payer, organization and currency'
        using errcode = '23514';
    end if;
    select coalesce(sum(amount), 0) into v_refunded from public.payments where reverses_payment_id = v_orig.id;
    select coalesce(sum(amount), 0) into v_allocated from public.payment_allocations where payment_id = v_orig.id;
    if v_refunded + v_allocated + new.amount > v_orig.amount then
      raise exception 'refund exceeds the unallocated remainder of the payment' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Распределение: только платёж (не возврат), выставленный счёт, одна валюта,
-- без превышения остатка платежа и суммы счёта.
create or replace function app.check_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment     public.payments%rowtype;
  v_invoice     public.invoices%rowtype;
  v_used        numeric;
  v_refunded    numeric;
  v_inv_paid    numeric;
begin
  select * into v_payment from public.payments where id = new.payment_id for update;
  select * into v_invoice from public.invoices where id = new.invoice_id for update;

  if v_payment.kind <> 'payment' then
    raise exception 'only payments can be allocated' using errcode = '23514';
  end if;
  if v_invoice.status <> 'issued' then
    raise exception 'payments can be allocated only to issued invoices' using errcode = '23514';
  end if;
  if v_payment.currency <> v_invoice.currency then
    raise exception 'currency mismatch' using errcode = '23514';
  end if;

  select coalesce(sum(amount), 0) into v_used from public.payment_allocations where payment_id = v_payment.id;
  select coalesce(sum(amount), 0) into v_refunded from public.payments where reverses_payment_id = v_payment.id;
  if v_used + v_refunded + new.amount > v_payment.amount then
    raise exception 'allocation exceeds the available payment amount' using errcode = '23514';
  end if;

  select coalesce(sum(amount), 0) into v_inv_paid from public.payment_allocations where invoice_id = v_invoice.id;
  if v_inv_paid + new.amount > v_invoice.total then
    raise exception 'allocation exceeds the invoice total' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function app.set_updated_at();
create trigger invoices_immutable before update on public.invoices
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'payer_id', 'created_by');
create trigger invoices_guard before insert or update on public.invoices
  for each row execute function app.guard_invoice();
create trigger invoices_no_delete before delete on public.invoices
  for each row execute function app.forbid_mutation();
create trigger invoices_audit after insert or update on public.invoices
  for each row execute function app.audit_row();

create trigger payments_check before insert on public.payments
  for each row execute function app.check_payment();
create trigger payments_append_only before update or delete on public.payments
  for each row execute function app.forbid_mutation();
create trigger payments_no_truncate before truncate on public.payments
  for each statement execute function app.forbid_mutation();
create trigger payments_audit after insert on public.payments
  for each row execute function app.audit_row();

create trigger payment_allocations_check before insert on public.payment_allocations
  for each row execute function app.check_allocation();
create trigger payment_allocations_append_only before update or delete on public.payment_allocations
  for each row execute function app.forbid_mutation();
create trigger payment_allocations_no_truncate before truncate on public.payment_allocations
  for each statement execute function app.forbid_mutation();
create trigger payment_allocations_audit after insert on public.payment_allocations
  for each row execute function app.audit_row();

-- Остаток по счёту — вычисляемый, единственный источник истины — распределения.
create view public.invoice_balances
with (security_invoker = true)
as
select
  i.id as invoice_id,
  i.organization_id,
  i.branch_id,
  i.payer_id,
  i.currency,
  i.total,
  coalesce(sum(pa.amount), 0)::numeric(14, 2) as paid,
  (i.total - coalesce(sum(pa.amount), 0))::numeric(14, 2) as outstanding,
  case
    when i.status <> 'issued' then i.status
    when coalesce(sum(pa.amount), 0) = 0 then 'unpaid'
    when coalesce(sum(pa.amount), 0) < i.total then 'partially_paid'
    else 'paid'
  end as payment_status
from public.invoices i
left join public.payment_allocations pa on pa.invoice_id = i.id
group by i.id;

-- ---------------------------------------------------------------------------
-- RLS. Запись требует MFA (aal2) — docs/architecture/AUTH_FLOWS.md §5.
-- ---------------------------------------------------------------------------
alter table public.invoices            enable row level security;
alter table public.payments            enable row level security;
alter table public.payment_allocations enable row level security;

create policy "finance staff, payers and guardians can read invoices" on public.invoices
  for select to authenticated using (
    payer_id = (select auth.uid())
    or app.is_guardian_of(payer_id)
    or app.has_permission(organization_id, branch_id, 'finance.read')
  );
create policy "finance writers with mfa can create invoices" on public.invoices
  for insert to authenticated with check (
    app.current_aal() = 'aal2' and created_by = (select auth.uid())
    and app.has_permission(organization_id, branch_id, 'finance.write')
  );
create policy "finance writers with mfa can update invoices" on public.invoices
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.write'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.write'));

create policy "finance staff, payers and guardians can read payments" on public.payments
  for select to authenticated using (
    payer_id = (select auth.uid())
    or app.is_guardian_of(payer_id)
    or app.has_permission(organization_id, branch_id, 'finance.read')
  );
create policy "finance staff with mfa can record payments and refunds" on public.payments
  for insert to authenticated with check (
    app.current_aal() = 'aal2' and created_by = (select auth.uid())
    and case kind
      when 'payment' then app.has_permission(organization_id, branch_id, 'finance.write')
      when 'refund'  then app.has_permission(organization_id, branch_id, 'finance.refund')
      else false
    end
  );

create policy "finance staff, payers and guardians can read allocations" on public.payment_allocations
  for select to authenticated using (
    app.has_permission(organization_id, branch_id, 'finance.read')
    or exists (
      select 1 from public.payments p
      where p.id = payment_id and (p.payer_id = (select auth.uid()) or app.is_guardian_of(p.payer_id))
    )
  );
create policy "finance writers with mfa can allocate payments" on public.payment_allocations
  for insert to authenticated with check (
    app.current_aal() = 'aal2' and created_by = (select auth.uid())
    and app.has_permission(organization_id, branch_id, 'finance.write')
  );

revoke all on public.invoices, public.payments, public.payment_allocations, public.invoice_balances
  from anon, authenticated;
grant select, insert, update on public.invoices to authenticated;
grant select, insert on public.payments, public.payment_allocations to authenticated;
grant select on public.invoice_balances to authenticated;
grant all on public.invoices, public.payments, public.payment_allocations to service_role;
grant select on public.invoice_balances to service_role;

-- Права на функции app: только явно выданные выше (см. 0001).
revoke execute on all functions in schema app from public, anon;
