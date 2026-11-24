-- מבנה הנתונים של אפליקציית התורים.
-- כל טבלה מפנה ל-businesses, כך שאפשר להרחיב לעסקים נוספים בלי הגירה.

create schema if not exists private;
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  timezone text not null default 'Asia/Jerusalem',
  created_at timestamptz not null default now()
);

create table public.settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  booking_window_days int not null default 30 check (booking_window_days between 1 and 365),
  min_notice_min int not null default 120 check (min_notice_min between 0 and 10080),
  buffer_min int not null default 10 check (buffer_min between 0 and 120),
  slot_step_min int not null default 30 check (slot_step_min in (10, 15, 20, 30, 60)),
  reminder_time time not null default '10:00',
  address text not null default '',
  contact_phone text not null default '',
  updated_at timestamptz not null default now()
);

-- מספרי הטלפון של בעלות העסק. מי שנכנסת עם מספר כזה מקבלת תפקיד owner.
create table public.owners (
  business_id uuid not null references public.businesses(id) on delete cascade,
  phone text not null,
  primary key (business_id, phone)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  duration_min int not null check (duration_min between 1 and 600),
  price int not null check (price between 0 and 100000),
  price_type text not null default 'fixed' check (price_type in ('fixed', 'per_unit')),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index services_business_idx on public.services (business_id, sort_order);

-- weekday: 0 = ראשון ... 6 = שבת. כמה שורות לאותו יום = כמה טווחים (למשל הפסקה).
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  check (start_time < end_time)
);
create index working_hours_business_idx on public.working_hours (business_id, weekday);

create table public.time_off (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text not null default '',
  created_at timestamptz not null default now(),
  check (start_at < end_at)
);
create index time_off_business_idx on public.time_off (business_id, end_at);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  phone text not null,
  name text,
  role text not null default 'customer' check (role in ('customer', 'owner')),
  created_at timestamptz not null default now(),
  unique (business_id, phone)
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid references public.profiles(id) on delete set null,
  customer_name text not null,
  customer_phone text,
  -- צילום של הטיפולים ברגע הקביעה: [{service_id, name, qty, duration_min, price, price_type}]
  items jsonb not null,
  total_price int not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  created_by text not null check (created_by in ('customer', 'owner')),
  cancelled_by text check (cancelled_by in ('customer', 'owner')),
  cancelled_at timestamptz,
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  check (start_at < end_at),
  -- אין כפל תורים: שני תורים פעילים באותו עסק לא יכולים לחפוף בזמן.
  constraint appointments_no_overlap
    exclude using gist (business_id with =, tstzrange(start_at, end_at) with &&)
    where (status = 'booked')
);
create index appointments_business_start_idx on public.appointments (business_id, start_at);
create index appointments_customer_idx on public.appointments (customer_id);
create index appointments_phone_idx on public.appointments (business_id, customer_phone);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_business_idx on public.push_subscriptions (business_id);
create index push_subscriptions_profile_idx on public.push_subscriptions (profile_id);

-- קודי כניסה חד-פעמיים. נשמר רק גיבוב של הקוד.
create table public.otp_codes (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  phone text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_codes_phone_idx on public.otp_codes (phone, created_at desc);
create index otp_codes_business_idx on public.otp_codes (business_id);

-- תור ההודעות היוצאות (וואטסאפ ללקוחה, פוש לבעלת העסק). משמש גם כיומן.
create table public.notifications (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete cascade,
  kind text not null check (kind in ('customer_confirm', 'customer_reminder', 'owner_booked', 'owner_cancelled', 'owner_test')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts int not null default 0,
  error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_pending_idx on public.notifications (status, id);
create index notifications_business_idx on public.notifications (business_id);
create index notifications_appointment_idx on public.notifications (appointment_id);

-- הגדרות וסודות של השרת (מפתחות פוש, וואטסאפ). לא נגיש דרך ה-API.
create table private.app_config (
  key text primary key,
  value text not null
);
