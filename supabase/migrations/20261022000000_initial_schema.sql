-- Initial Schema Migration for My Receipt Desk (Campaign 21 Knowledge Loop)

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. Meta / Settings table
create table if not exists public.meta (
  key text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. File Store
create table if not exists public.files (
  key text primary key,
  workspace_id text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  storage_path text,
  data bytea,
  created_at timestamptz not null default now()
);

-- 3. Source Documents
create table if not exists public.source_documents (
  id text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  sha256 text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  source_type text not null check (source_type in ('demo_receipt_image', 'demo_statement_csv', 'receipt_upload', 'invoice_upload', 'statement_csv')),
  imported_at timestamptz not null default now(),
  file_key text not null
);

create index if not exists idx_source_documents_workspace on public.source_documents(workspace_id);
create index if not exists idx_source_documents_sha256 on public.source_documents(sha256);

-- 4. Receipts
create table if not exists public.receipts (
  id text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  source_document_id text not null references public.source_documents(id) on delete cascade,
  fixture_id text,
  adapter jsonb not null,
  fields jsonb not null,
  printed_text text,
  canonical_merchant_id text,
  disposition text not null check (disposition in ('active', 'set_aside_duplicate')),
  category jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_receipts_workspace on public.receipts(workspace_id);
create index if not exists idx_receipts_source_document on public.receipts(source_document_id);
create index if not exists idx_receipts_canonical_merchant on public.receipts(canonical_merchant_id);

-- 5. Statement Transactions
create table if not exists public.statement_transactions (
  id text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  source_document_id text not null references public.source_documents(id) on delete cascade,
  source_row_id text not null,
  row_number integer not null,
  reference text,
  account_id text not null,
  account_label text not null,
  raw_label text not null,
  normalized_label text not null,
  transaction_date date,
  posting_date date not null,
  currency text not null,
  direction text not null check (direction in ('debit', 'credit')),
  amount_minor bigint not null,
  intake text not null check (intake in ('available', 'quarantined_currency', 'credit_not_supported', 'set_aside_duplicate')),
  duplicate_suspected boolean not null default false,
  duplicate_of text,
  duplicate_resolution text,
  raw_cells jsonb not null default '[]'::jsonb
);

create index if not exists idx_transactions_workspace on public.statement_transactions(workspace_id);
create index if not exists idx_transactions_source_document on public.statement_transactions(source_document_id);
create index if not exists idx_transactions_posting_date on public.statement_transactions(posting_date);

-- 6. Payables / Invoices
create table if not exists public.payables (
  id text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  source_document_id text not null references public.source_documents(id) on delete cascade,
  supplier_name text not null,
  canonical_merchant_id text not null,
  invoice_number text,
  invoice_date date not null,
  amount_minor bigint not null,
  currency text not null,
  state text not null check (state in ('unpaid', 'paid')),
  paid_by_match_id text
);

create index if not exists idx_payables_workspace on public.payables(workspace_id);

-- 7. Confirmed Matches
create table if not exists public.confirmed_matches (
  id text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  method text not null,
  receipt_id text references public.receipts(id) on delete set null,
  transaction_id text not null references public.statement_transactions(id) on delete cascade,
  payable_id text references public.payables(id) on delete set null,
  confidence text not null check (confidence in ('high', 'medium', 'low', 'manual')),
  rule_refs jsonb not null default '[]'::jsonb,
  confirmed_at timestamptz not null default now(),
  confirmed_by text not null
);

create index if not exists idx_matches_workspace on public.confirmed_matches(workspace_id);
create index if not exists idx_matches_receipt on public.confirmed_matches(receipt_id);
create index if not exists idx_matches_transaction on public.confirmed_matches(transaction_id);

-- 8. Ledger Entries
create table if not exists public.ledger_entries (
  id text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  origin text not null check (origin in ('receipt_match', 'statement_only', 'invoice_payment')),
  identity_key text not null,
  active_identity_key text,
  status text not null check (status in ('recorded', 'voided')),
  expense_date date not null,
  merchant_name text not null,
  canonical_merchant_id text,
  amount_minor bigint not null,
  currency text not null,
  category jsonb not null,
  evidence jsonb not null,
  rule_refs jsonb not null default '[]'::jsonb,
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);

create unique index if not exists idx_ledger_active_identity on public.ledger_entries(workspace_id, active_identity_key) where active_identity_key is not null;
create index if not exists idx_ledger_workspace on public.ledger_entries(workspace_id);
create index if not exists idx_ledger_expense_date on public.ledger_entries(expense_date);

-- 9. Rule Heads and Rule Versions (Knowledge Repository)
create table if not exists public.rule_heads (
  rule_id text not null,
  workspace_id text not null,
  schema_version integer not null default 1,
  type text not null check (type in ('merchant_alias', 'category_preference', 'posting_window')),
  status text not null check (status in ('draft_only', 'active', 'suspended', 'discarded')),
  active_version integer,
  latest_version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, rule_id)
);

create table if not exists public.rule_versions (
  rule_id text not null,
  version integer not null,
  workspace_id text not null,
  schema_version integer not null default 1,
  type text not null check (type in ('merchant_alias', 'category_preference', 'posting_window')),
  owner_id text not null,
  plain_english text not null,
  scope jsonb not null,
  condition jsonb not null,
  action jsonb not null,
  exclusions jsonb not null default '[]'::jsonb,
  evidence_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  approved_by text,
  approved_at timestamptz,
  discarded_at timestamptz,
  primary key (workspace_id, rule_id, version)
);

-- 10. Review Decisions
create table if not exists public.review_decisions (
  id text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  actor text not null,
  reason text,
  details jsonb not null default '{}'::jsonb,
  decided_at timestamptz not null default now()
);

create index if not exists idx_decisions_workspace on public.review_decisions(workspace_id);

-- 11. Audit Events (Tamper-evident log)
create table if not exists public.audit_events (
  id text primary key,
  workspace_id text not null,
  schema_version integer not null default 1,
  timestamp timestamptz not null default now(),
  event_type text not null,
  actor text not null,
  payload jsonb not null,
  prev_event_hash text,
  event_hash text not null
);

create index if not exists idx_audit_workspace on public.audit_events(workspace_id);
create index if not exists idx_audit_timestamp on public.audit_events(timestamp);

-- Enable Row Level Security (RLS) on all tables
alter table public.meta enable row level security;
alter table public.files enable row level security;
alter table public.source_documents enable row level security;
alter table public.receipts enable row level security;
alter table public.statement_transactions enable row level security;
alter table public.payables enable row level security;
alter table public.confirmed_matches enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.rule_heads enable row level security;
alter table public.rule_versions enable row level security;
alter table public.review_decisions enable row level security;
alter table public.audit_events enable row level security;

-- Default permissive RLS policies for authenticated users and anon development
do $$
declare
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop policy if exists "Allow all operations for authenticated and anon" on public.%I;', t);
    execute format('create policy "Allow all operations for authenticated and anon" on public.%I for all using (true) with check (true);', t);
  end loop;
end;
$$;
