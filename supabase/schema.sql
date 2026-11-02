-- МультоРетик Бот · схема базы (Supabase / Postgres)
-- Все чтения и записи идут только через edge function `bot` (service role).
-- RLS включён, публичных политик нет: из браузера напрямую к таблицам не достучаться.

create table if not exists users (
  tg_id        bigint primary key,
  username     text,
  name         text,
  ref_by       bigint references users(tg_id) on delete set null,
  ref_rewarded boolean not null default false,       -- награда «приведи друга» уже выдана (за первый код друга)
  coins        int not null default 0 check (coins >= 0),
  streak       int not null default 0,               -- дней подряд
  last_daily   date,                                 -- день последнего ежедневного бонуса (Europe/Moscow)
  subs         text[] not null default array['МультоРетик','КотоРетик','СмешаРетик','SOIKAC','Анти Котополис','ПеппаРетик'],
  notify       boolean not null default true,
  blocked      boolean not null default false,       -- пользователь заблокировал бота (403) — не слать
  last_notify  timestamptz,
  created_at   timestamptz not null default now(),
  seen_at      timestamptz not null default now()
);

-- серии: RETIKO регистрирует каждую вышедшую серию (tools/publish_to_bot.py)
create table if not exists videos (
  id           text primary key,                     -- id задания RETIKO
  channel      text not null,
  title        text not null default '',
  yt_url       text,
  vk_url       text,
  rt_url       text,
  thumb_url    text,
  code         text not null unique,                 -- 5 цифр, показывается в конце серии (резервируется при сборке видео)
  published_at timestamptz,                          -- null = код зарезервирован, серия ещё не вышла
  notified_at  timestamptz
);
create index if not exists videos_pub on videos (published_at desc);

-- карточки персонажей (свои «ретик»-версии)
create table if not exists cards (
  id       text primary key,
  name     text not null,
  channel  text not null,
  rarity   text not null check (rarity in ('common','rare','epic','legend')),
  img      text not null,                            -- путь в web/cards/
  descr    text not null default '',
  active   boolean not null default true
);

create table if not exists user_cards (
  tg_id    bigint references users(tg_id) on delete cascade,
  card_id  text references cards(id) on delete cascade,
  count    int not null default 1,
  first_at timestamptz not null default now(),
  primary key (tg_id, card_id)
);

-- активированные коды: один код — один раз на человека
create table if not exists redemptions (
  tg_id    bigint references users(tg_id) on delete cascade,
  video_id text references videos(id) on delete cascade,
  fresh    boolean not null,                         -- введён в первые 48 часов после выхода
  at       timestamptz not null default now(),
  primary key (tg_id, video_id)
);

-- неверные попытки ввода кода (защита от перебора)
create table if not exists code_attempts (
  tg_id bigint not null,
  at    timestamptz not null default now()
);
create index if not exists code_attempts_user on code_attempts (tg_id, at desc);

alter table users         enable row level security;
alter table videos        enable row level security;
alter table cards         enable row level security;
alter table user_cards    enable row level security;
alter table redemptions   enable row level security;
alter table code_attempts enable row level security;

-- атомарно добавить карточки и монеты (вызывает только функция)
create or replace function grant_cards(u bigint, ids text[], add_coins int)
returns void language plpgsql security definer set search_path = public as $$
declare c text;
begin
  foreach c in array ids loop
    insert into user_cards (tg_id, card_id) values (u, c)
    on conflict (tg_id, card_id) do update set count = user_cards.count + 1;
  end loop;
  update users set coins = coins + add_coins where tg_id = u;
end $$;
revoke all on function grant_cards(bigint, text[], int) from public, anon, authenticated;

-- списать монеты, если хватает; true = списано
create or replace function spend_coins(u bigint, amount int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update users set coins = coins - amount where tg_id = u and coins >= amount;
  return found;
end $$;
revoke all on function spend_coins(bigint, int) from public, anon, authenticated;

-- рейтинг коллекционеров: число разных карточек
create or replace view leaderboard as
  select u.tg_id, coalesce(u.name, u.username, 'Зритель') as name,
         count(uc.card_id) as unique_cards, coalesce(sum(uc.count), 0) as total_cards
  from users u left join user_cards uc on uc.tg_id = u.tg_id
  group by u.tg_id
  order by unique_cards desc, total_cards desc;

-- PostgREST по умолчанию отдаёт новые объекты anon/authenticated — закрываем, всё идёт через функцию
revoke all on leaderboard from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
