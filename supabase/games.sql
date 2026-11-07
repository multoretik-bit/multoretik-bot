-- МультоРетик Бот · интерактивы (07.11.2026): викторина по серии, общий босс дня (тапалка), колесо удачи,
-- мини-игра «Найди пару», крафт дублей, награда за собранный набор канала.
-- Как и всё остальное — только через edge function `bot` (service role), RLS без публичных политик.

-- викторина: RETIKO после выкладки серии присылает 3 вопроса по сценарию (action "quiz")
create table if not exists quizzes (
  video_id   text primary key references videos(id) on delete cascade,
  questions  jsonb not null,                         -- [{q, a:[4 строки], right:0..3}]
  created_at timestamptz not null default now()
);
create table if not exists quiz_answers (
  tg_id    bigint references users(tg_id) on delete cascade,
  video_id text references videos(id) on delete cascade,
  correct  int not null,
  at       timestamptz not null default now(),
  primary key (tg_id, video_id)
);

-- босс дня: все игроки вместе бьют одного монстра (карточку); последний удар — карточка босса
create table if not exists bosses (
  day         date primary key,                      -- день по Москве
  card_id     text references cards(id),
  hp          int not null,
  max_hp      int not null,
  defeated_at timestamptz,
  last_hit_by bigint
);
create table if not exists boss_hits (
  day     date,
  tg_id   bigint references users(tg_id) on delete cascade,
  hits    int not null default 0,
  last_at timestamptz not null default now(),
  claimed boolean not null default false,
  primary key (day, tg_id)
);
create index if not exists boss_hits_top on boss_hits (day, hits desc);

-- мини-игры: сколько раз сыграл и выиграл за день (награда — первые победы дня)
create table if not exists game_days (
  tg_id      bigint references users(tg_id) on delete cascade,
  day        date,
  game       text,
  plays      int not null default 0,
  wins       int not null default 0,
  started_at timestamptz,
  primary key (tg_id, day, game)
);

-- награда за полностью собранный набор канала (один раз)
create table if not exists set_claims (
  tg_id   bigint references users(tg_id) on delete cascade,
  channel text,
  at      timestamptz not null default now(),
  primary key (tg_id, channel)
);

alter table users add column if not exists last_spin date;     -- колесо удачи — раз в день

alter table quizzes      enable row level security;
alter table quiz_answers enable row level security;
alter table bosses       enable row level security;
alter table boss_hits    enable row level security;
alter table game_days    enable row level security;
alter table set_claims   enable row level security;

-- удар по боссу: не больше энергии на день, не чаще ~15 ударов в секунду, не больше остатка здоровья
create or replace function boss_hit(u bigint, d date, n int, energy int)
returns table(o_applied int, o_hp int, o_max int, o_my int, o_killer boolean)
language plpgsql security definer set search_path = public as $$
declare cur boss_hits%rowtype; b bosses%rowtype; allow int;
begin
  insert into boss_hits (day, tg_id, last_at) values (d, u, now() - interval '5 seconds') on conflict do nothing;
  select * into cur from boss_hits where day = d and tg_id = u for update;
  select * into b from bosses where day = d for update;
  if b.day is null then return; end if;
  allow := least(greatest(n, 0), energy - cur.hits, floor(extract(epoch from now() - cur.last_at) * 15)::int + 6, b.hp);
  allow := greatest(allow, 0);
  update boss_hits set hits = boss_hits.hits + allow, last_at = now() where day = d and tg_id = u;
  if allow > 0 then
    update bosses set hp = bosses.hp - allow,
      defeated_at = case when bosses.hp - allow <= 0 then now() else null end,
      last_hit_by = case when bosses.hp - allow <= 0 then u else null end
    where day = d;
  end if;
  return query select allow, b.hp - allow, b.max_hp, cur.hits + allow, (allow > 0 and b.hp - allow <= 0);
end $$;
revoke all on function boss_hit(bigint, date, int, int) from public, anon, authenticated;

-- списать n дублей (одна карточка всегда остаётся в коллекции); true = списано
create or replace function spend_dupes(u bigint, c text, n int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update user_cards set count = count - n where tg_id = u and card_id = c and count >= n + 1;
  return found;
end $$;
revoke all on function spend_dupes(bigint, text, int) from public, anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
