create table auth_methods (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id),
  method_type text not null check (method_type in ('recovery_email','dashboard_auth')),
  value text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id text references users(user_id),
  phone_number text not null unique,
  wa_id text,
  display_name text,
  status text not null default 'active' check (status in ('active','unlinked')),
  last_inbound_at timestamptz,
  linked_at timestamptz not null default now()
);

create table otp_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text references users(user_id),
  channel text not null default 'email',
  destination text not null,
  otp_hash text not null,
  purpose text not null check (purpose in ('signup_email_verify','account_recovery','link_new_number')),
  expires_at timestamptz not null,
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  status text not null default 'pending' check (status in ('pending','verified','expired','locked')),
  requester_phone text,
  created_at timestamptz not null default now()
);

create table conversation_sessions (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null,
  user_id text references users(user_id),
  state text not null default 'new',
  context jsonb not null default '{}'::jsonb,
  last_message_at timestamptz not null default now(),
  expires_at timestamptz
);

create table conversation_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references conversation_sessions(id),
  direction text not null check (direction in ('inbound','outbound')),
  message_type text not null check (message_type in ('text','image','document','interactive')),
  content text,
  media_url text,
  wa_message_id text,
  created_at timestamptz not null default now()
);

create table auth_log (
  log_id text primary key,
  user_id text references users(user_id),
  company_id text references companies(company_id),
  event_type text not null check (event_type in
    ('login_success','login_failed','mfa_verified','password_reset','otp_requested','otp_verified','account_locked')),
  ip_address text,
  device text,
  success boolean not null,
  "timestamp" timestamptz not null default now()
);