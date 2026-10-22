-- Invite Keys and Guest Access Management for My Receipt Desk

create table if not exists public.invitations (
  code text primary key,
  guest_name text,
  revoked boolean not null default false,
  max_uses integer,
  use_count integer not null default 0,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.invitations enable row level security;

-- Drop function if exists
drop function if exists public.validate_invite_key(text);

-- Security definer RPC function to validate invite key and record usage
create or replace function public.validate_invite_key(input_key text)
returns jsonb
language plpgsql
security definer
as $$
declare
  inv record;
begin
  if input_key is null or trim(input_key) = '' then
    return jsonb_build_object('valid', false, 'reason', 'empty_key');
  end if;

  select * into inv from public.invitations where lower(code) = lower(trim(input_key));
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'invalid_code');
  end if;

  if inv.revoked then
    return jsonb_build_object('valid', false, 'reason', 'revoked');
  end if;

  if inv.expires_at is not null and inv.expires_at < now() then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;

  if inv.max_uses is not null and inv.use_count >= inv.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'max_uses_exceeded');
  end if;

  -- Record usage
  update public.invitations
  set use_count = use_count + 1,
      last_used_at = now()
  where code = inv.code;

  return jsonb_build_object(
    'valid', true,
    'code', inv.code,
    'guest_name', inv.guest_name
  );
end;
$$;

-- Grant execution to anon and authenticated
grant execute on function public.validate_invite_key(text) to anon, authenticated;

-- Insert initial VIP and Guest invite keys
insert into public.invitations (code, guest_name, max_uses) values
  ('VIP-CAMPAIGN21-DEMO', 'VIP Guest', 100),
  ('DEMO-REVIEW-2026', 'Reviewer', 50),
  ('EXECUTIVE-PREVIEW', 'Executive Partner', 20)
on conflict (code) do nothing;
