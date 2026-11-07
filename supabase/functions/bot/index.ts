// МультоРетик Бот · edge function `bot`
// POST ?hook=1 (вебхук Telegram)      -> /start [ref_<id>], ввод кода сообщением, /stop, блокировка бота
// POST {action:"me", initData}       -> профиль + ежедневный бонус, карточки, лента серий, рейтинг
// POST {action:"redeem", initData, code}
// POST {action:"pack", initData}     -> набор за монеты
// POST {action:"subs", initData, subs, notify}
// POST {action:"reserve", key, video} -> RETIKO при сборке видео получает код серии
// POST {action:"publish", key, video} -> RETIKO после выкладки: ссылки и время выхода
// POST {action:"tick", key}          -> pg_cron: уведомить о сериях, чьё время выхода наступило
// POST {action:"quiz", key, video:{id, questions}} -> RETIKO: викторина по сценарию серии
// интерактивы (initData): quiz_get/quiz_answer {video, answers}, boss, hit {n}, boss_claim, spin, game_start/game_win {game}, craft {card}, set_claim {channel}
import { createClient } from "npm:@supabase/supabase-js@2.117.0";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const HOOK_SECRET = Deno.env.get("TG_HOOK_SECRET")!;
const PUBLISH_KEY = Deno.env.get("PUBLISH_KEY")!;
const APP = Deno.env.get("APP_URL")!;                    // адрес мини-приложения (GitHub Pages)
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });

const FRESH_N = 3;             // код «свежий» только у 3 последних вышедших серий сети — 3 карточки, дальше по 1
const PACK_PRICE = 50;
const DAILY_COINS = 5;
const NOTIFY_GAP_H = 3;        // не чаще одного уведомления в 3 часа
const MAX_BAD_CODES = 8;       // неверных кодов в час
const WEIGHTS: Record<string, number> = { common: 65, rare: 25, epic: 8, legend: 2 };
const RARE_UP = ["rare", "epic", "legend"];
const OWNER_IDS = (Deno.env.get("OWNER_IDS") || "1202933488").split(",").map(Number);   // владелец: все карточки + статистика

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const enc = new TextEncoder();
const hmac = async (key: Uint8Array | string, msg: string) => {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const tg = (method: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false }));
const later = (q: PromiseLike<unknown>) => {                       // запросы Supabase — «thenable», а не Promise
  const p = Promise.resolve(q).catch(() => {});
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
};
const mskDay = (d = new Date()) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };

async function verify(initData: string): Promise<TgUser | null> {
  const p = new URLSearchParams(initData || "");
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  if (hex(await hmac(await hmac("WebAppData", BOT), check)) !== hash) return null;
  if (!(Date.now() / 1000 - Number(p.get("auth_date") || 0) < 86400)) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

async function upsertUser(u: TgUser, refBy?: number) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
  const { data: old } = await db.from("users").select("*").eq("tg_id", u.id).maybeSingle();
  if (old) {
    later(db.from("users").update({ username: u.username || null, name, seen_at: new Date().toISOString(), blocked: false }).eq("tg_id", u.id));
    return { ...old, username: u.username || null, name, isNew: false };
  }
  const ref = refBy && refBy !== u.id ? refBy : null;
  const row = { tg_id: u.id, username: u.username || null, name, ref_by: null as number | null };
  if (ref) {
    const { data: r } = await db.from("users").select("tg_id").eq("tg_id", ref).maybeSingle();
    if (r) row.ref_by = ref;
  }
  const { data } = await db.from("users").insert(row).select("*").single();
  return { ...data, isNew: true };
}

// ---------------------------------------------------------------- карточки
let CARDS: any[] | null = null;
async function cards() {
  if (!CARDS) CARDS = (await db.from("cards").select("*").eq("active", true)).data || [];
  return CARDS;
}
function pick(pool: any[], allowed: string[]) {
  const by = allowed.map((r) => [r, pool.filter((c) => c.rarity === r)] as const).filter(([, l]) => l.length);
  const total = by.reduce((s, [r]) => s + WEIGHTS[r], 0);
  let x = Math.random() * total;
  for (const [r, list] of by) {
    x -= WEIGHTS[r];
    if (x <= 0) return list[Math.floor(Math.random() * list.length)];
  }
  const last = by[by.length - 1][1];
  return last[Math.floor(Math.random() * last.length)];
}
// n карточек; rareSlot — одна гарантированно редкая или лучше
async function roll(n: number, rareSlot: boolean) {
  const pool = await cards();
  if (!pool.length) return [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(pool, i === 0 && rareSlot ? RARE_UP : Object.keys(WEIGHTS)));
  return out.filter(Boolean);
}
async function give(u: number, list: any[], coins: number) {
  await db.rpc("grant_cards", { u, ids: list.map((c) => c.id), add_coins: coins });
  return list.map((c) => ({ id: c.id, name: c.name, rarity: c.rarity, img: c.img, channel: c.channel }));
}

// ---------------------------------------------------------------- действия
async function daily(user: any) {
  const today = mskDay();
  if (user.last_daily === today) return null;
  const yesterday = mskDay(new Date(Date.now() - 86400e3));
  const streak = user.last_daily === yesterday ? user.streak + 1 : 1;
  const mark = db.from("users").update({ last_daily: today, streak }).eq("tg_id", user.tg_id);
  const prize = streak % 7 === 0 ? await roll(3, true) : await roll(1, false);   // вход за день — 1 случайная карточка, 7-й день подряд — набор из 3
  const [pack] = await Promise.all([give(user.tg_id, prize, DAILY_COINS), mark]);
  return { streak, coins: DAILY_COINS, pack };
}

// id трёх последних вышедших серий (по всей сети, время выхода уже наступило)
async function freshIds(): Promise<string[]> {
  const { data } = await db.from("videos").select("id").not("published_at", "is", null)
    .lte("published_at", new Date().toISOString()).order("published_at", { ascending: false }).limit(FRESH_N);
  return (data || []).map((r) => r.id);
}

async function ownerStats(id: number) {
  // владельцу — все карточки коллекции (и новые, когда они появятся)
  const have = new Set(((await db.from("user_cards").select("card_id").eq("tg_id", id)).data || []).map((r) => r.card_id));
  const missing = (await cards()).filter((c) => !have.has(c.id)).map((c) => ({ tg_id: id, card_id: c.id }));
  if (missing.length) await db.from("user_cards").insert(missing);
  const day = new Date(Date.now() - 86400e3).toISOString();
  const today = new Date(mskDay() + "T00:00:00+03:00").toISOString();
  const cnt = async (q: any) => (await q).count || 0;
  const [users, notify, new24, codes, todayCodes, videos] = await Promise.all([
    cnt(db.from("users").select("tg_id", { count: "exact", head: true })),
    cnt(db.from("users").select("tg_id", { count: "exact", head: true }).eq("notify", true).eq("blocked", false)),
    cnt(db.from("users").select("tg_id", { count: "exact", head: true }).gte("created_at", day)),
    cnt(db.from("redemptions").select("tg_id", { count: "exact", head: true })),
    cnt(db.from("redemptions").select("tg_id", { count: "exact", head: true }).gte("at", today)),
    cnt(db.from("videos").select("id", { count: "exact", head: true }).not("published_at", "is", null)),
  ]);
  return { users, notify, new24, codes, today: todayCodes, videos };
}

async function me(u: TgUser) {
  const user = await upsertUser(u);
  const freshP = freshIds();
  const [bonus, owner] = await Promise.all([daily(user), OWNER_IDS.includes(u.id) ? ownerStats(u.id) : null, cards()]);
  const [{ data: fresh }, { data: mine }, { data: vids }, { data: top }, { data: done }, { count: friends }] = await Promise.all([
    db.from("users").select("coins,streak,subs,notify,last_spin").eq("tg_id", u.id).single(),
    db.from("user_cards").select("card_id,count").eq("tg_id", u.id),
    db.from("videos").select("id,channel,title,yt_url,vk_url,rt_url,thumb_url,published_at")
      .not("notified_at", "is", null).order("published_at", { ascending: false }).limit(40),
    db.from("leaderboard").select("tg_id,name,unique_cards").limit(20),
    db.from("redemptions").select("video_id").eq("tg_id", u.id),
    db.from("users").select("tg_id", { count: "exact", head: true }).eq("ref_by", u.id),
  ]);
  const freshList = await freshP;
  const [{ data: qz }, { data: qa }, { data: sc }, bossRow] = await Promise.all([
    db.from("quizzes").select("video_id").in("video_id", (vids || []).map((v) => v.id)),
    db.from("quiz_answers").select("video_id,correct").eq("tg_id", u.id),
    db.from("set_claims").select("channel").eq("tg_id", u.id),
    bossToday().catch(() => null),
  ]);
  const bossCard = bossRow ? (await cards()).find((c) => c.id === bossRow.card_id) : null;
  return json({
    me: { id: u.id, name: user.name, ...fresh, friends: friends || 0 },
    bonus, cards: await cards(), mine: mine || [], videos: vids || [],
    redeemed: (done || []).map((r) => r.video_id), top: top || [],
    packPrice: PACK_PRICE, owner, fresh: freshList,
    quizzes: (qz || []).map((q) => q.video_id), quizDone: Object.fromEntries((qa || []).map((q) => [q.video_id, q.correct])),
    boss: bossCard ? { card: pub(bossCard), hp: bossRow.hp, max: bossRow.max_hp, defeated: !!bossRow.defeated_at } : null,
    sets: (sc || []).map((x) => x.channel), spinToday: fresh?.last_spin === mskDay(), wheel: WHEEL.map(({ w, ...x }) => x),
  });
}

async function redeem(u: TgUser, raw: string) {
  const code = String(raw || "").replace(/\D/g, "");
  if (code.length !== 5) return json({ error: "Код — это 5 цифр из серии" }, 400);
  const since = new Date(Date.now() - 3600e3).toISOString();
  const { count: bad } = await db.from("code_attempts").select("tg_id", { count: "exact", head: true }).eq("tg_id", u.id).gte("at", since);
  if ((bad || 0) >= MAX_BAD_CODES) return json({ error: "Слишком много неверных кодов. Попробуй через час" }, 429);
  const { data: v } = await db.from("videos").select("id,channel,title,published_at").eq("code", code).maybeSingle();
  if (!v || !v.published_at) {
    await db.from("code_attempts").insert({ tg_id: u.id });
    return json({ error: "Такого кода нет. Проверь цифры из серии" }, 404);
  }
  const user = await upsertUser(u);
  if (new Date(v.published_at).getTime() > Date.now()) return json({ error: "Эта серия ещё не вышла" }, 404);
  const fresh = (await freshIds()).includes(v.id);
  const ins = await db.from("redemptions").insert({ tg_id: u.id, video_id: v.id, fresh });
  if (ins.error) return json({ error: "Этот код ты уже вводил. Жди код в следующей серии!" }, 409);
  const got = await give(u.id, await roll(fresh ? 3 : 1, fresh), fresh ? 20 : 10);
  let friend = null;
  if (user.ref_by && !user.ref_rewarded) {                      // первый код приглашённого — награда обоим
    await db.from("users").update({ ref_rewarded: true }).eq("tg_id", u.id);
    const mineGift = await give(u.id, await roll(1, true), 30);
    const theirs = await give(user.ref_by, await roll(1, true), 30);
    got.push(...mineGift);
    friend = true;
    later(tg("sendMessage", { chat_id: user.ref_by, text: `🎁 Твой друг ${user.name || ""} ввёл первый код! Тебе редкая карточка «${theirs[0]?.name}» и 30 монет.`,
      reply_markup: { inline_keyboard: [[{ text: "Открыть коллекцию", web_app: { url: APP } }]] } }));
  }
  return json({ ok: true, fresh, video: v, cards: got, coins: (fresh ? 20 : 10) + (friend ? 30 : 0), friend });
}

async function pack(u: TgUser) {
  const { data: ok } = await db.rpc("spend_coins", { u: u.id, amount: PACK_PRICE });
  if (!ok) return json({ error: `Нужно ${PACK_PRICE} монет` }, 400);
  return json({ ok: true, cards: await give(u.id, await roll(3, false), 0) });
}

async function subs(u: TgUser, list: unknown, notify: unknown) {
  const s = Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, 20) : undefined;
  const patch: Record<string, unknown> = {};
  if (s) patch.subs = s;
  if (typeof notify === "boolean") patch.notify = notify;
  await db.from("users").update(patch).eq("tg_id", u.id);
  return json({ ok: true });
}

// ---------------------------------------------------------------- интерактивы (07.11)
const BOSS_ENERGY = 300;       // ударов по боссу в день на человека
const BOSS_MIN_HITS = 30;      // столько ударов — и участник получает награду, если босса победили
const QUIZ_COIN = 5, QUIZ_ALL = 10;
const GAME_WINS = 3, GAME_COIN = 5;   // «Найди пару»: монеты за первые 3 победы дня
const SET_COINS = 100;
const NEXT: Record<string, string> = { common: "rare", rare: "epic", epic: "legend" };
const WHEEL = [                 // сектора колеса (порядок = как нарисовано в приложении)
  { kind: "coins", n: 5, w: 30 }, { kind: "card", r: "any", w: 15 }, { kind: "coins", n: 10, w: 24 }, { kind: "card", r: "rare", w: 8 },
  { kind: "coins", n: 20, w: 14 }, { kind: "coins", n: 50, w: 4 }, { kind: "coins", n: 15, w: 3 }, { kind: "card", r: "epic", w: 2 },
];
const pub = (c: any) => ({ id: c.id, name: c.name, rarity: c.rarity, img: c.img, channel: c.channel });

async function quizGet(u: TgUser, vid: string) {
  const [{ data: q }, { data: done }] = await Promise.all([
    db.from("quizzes").select("questions").eq("video_id", String(vid)).maybeSingle(),
    db.from("quiz_answers").select("correct").eq("tg_id", u.id).eq("video_id", String(vid)).maybeSingle(),
  ]);
  if (!q) return json({ error: "Для этой серии викторины пока нет" }, 404);
  return json({ ok: true, done: done ? done.correct : null,
    questions: (q.questions as any[]).map((x) => ({ q: x.q, a: x.a })) });
}

async function quizAnswer(u: TgUser, vid: string, answers: unknown) {
  const { data: q } = await db.from("quizzes").select("questions").eq("video_id", String(vid)).maybeSingle();
  if (!q || !Array.isArray(answers)) return json({ error: "Викторина не найдена" }, 404);
  await upsertUser(u);
  const qs = q.questions as any[];
  const right = qs.map((x) => x.right);
  const correct = qs.reduce((s, x, i) => s + (Number(answers[i]) === x.right ? 1 : 0), 0);
  const ins = await db.from("quiz_answers").insert({ tg_id: u.id, video_id: String(vid), correct });
  if (ins.error) return json({ error: "Ты уже проходил эту викторину" }, 409);
  const coins = correct * QUIZ_COIN + (correct === qs.length ? QUIZ_ALL : 0);
  if (coins) await db.rpc("grant_cards", { u: u.id, ids: [], add_coins: coins });
  return json({ ok: true, correct, total: qs.length, right, coins });
}

async function bossToday() {
  const day = mskDay();
  let { data: b } = await db.from("bosses").select("*").eq("day", day).maybeSingle();
  if (!b) {
    const pool = (await cards()).filter((c) => c.rarity === "epic" || c.rarity === "legend");
    const seed = [...day].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const card = pool[seed % pool.length];
    const since = new Date(Date.now() - 3 * 86400e3).toISOString();
    const { count } = await db.from("users").select("tg_id", { count: "exact", head: true }).gte("seen_at", since);
    const hp = Math.max(1000, Math.round(((count || 0) * 70) / 100) * 100);    // ~ по 70 ударов на каждого, кто заходил за 3 дня
    await db.from("bosses").insert({ day, card_id: card?.id, hp, max_hp: hp });
    b = (await db.from("bosses").select("*").eq("day", day).single()).data;
  }
  return b;
}

async function boss(u: TgUser) {
  const b = await bossToday();
  const [{ data: mine }, { data: top }] = await Promise.all([
    db.from("boss_hits").select("hits,claimed").eq("day", b.day).eq("tg_id", u.id).maybeSingle(),
    db.from("boss_hits").select("tg_id,hits").eq("day", b.day).gt("hits", 0).order("hits", { ascending: false }).limit(5),
  ]);
  const ids = (top || []).map((t) => t.tg_id);
  const { data: names } = ids.length ? await db.from("users").select("tg_id,name,username").in("tg_id", ids) : { data: [] as any[] };
  const nm = Object.fromEntries((names || []).map((n) => [n.tg_id, n.name || n.username || "Зритель"]));
  const card = (await cards()).find((c) => c.id === b.card_id);
  const my = mine?.hits || 0;
  return json({ ok: true, day: b.day, card: card ? pub(card) : null, hp: b.hp, max: b.max_hp, defeated: !!b.defeated_at,
    killer: b.last_hit_by === u.id, my, energy: BOSS_ENERGY, need: BOSS_MIN_HITS,
    canClaim: !!b.defeated_at && !mine?.claimed && my >= BOSS_MIN_HITS, claimed: !!mine?.claimed,
    top: (top || []).map((t) => ({ name: nm[t.tg_id] || "Зритель", hits: t.hits, me: t.tg_id === u.id })) });
}

async function hit(u: TgUser, n: unknown) {
  const b = await bossToday();
  await upsertUser(u);
  const { data, error } = await db.rpc("boss_hit", { u: u.id, d: b.day, n: Math.min(60, Math.max(0, Number(n) || 0)), energy: BOSS_ENERGY });
  if (error) return json({ error: error.message }, 500);
  const r = (data || [])[0] || {};
  return json({ ok: true, applied: r.o_applied || 0, hp: r.o_hp ?? b.hp, max: r.o_max ?? b.max_hp, my: r.o_my || 0, killer: !!r.o_killer });
}

async function bossClaim(u: TgUser) {
  const b = await bossToday();
  if (!b.defeated_at) return json({ error: "Босс ещё жив — бей!" }, 400);
  const { data: ok } = await db.from("boss_hits").update({ claimed: true }).eq("day", b.day).eq("tg_id", u.id)
    .eq("claimed", false).gte("hits", BOSS_MIN_HITS).select("tg_id");
  if (!ok?.length) return json({ error: `Награда — тем, кто нанёс от ${BOSS_MIN_HITS} ударов` }, 400);
  const bc = (await cards()).find((c) => c.id === b.card_id);   // каждому участнику — сама карточка босса
  const list = bc ? [bc] : [];
  if (b.last_hit_by === u.id) list.push(...(await roll(1, true)));   // последний удар — ещё и редкая
  return json({ ok: true, cards: await give(u.id, list, 15), coins: 15, killer: b.last_hit_by === u.id });
}

async function spin(u: TgUser) {
  const today = mskDay();
  await upsertUser(u);
  const { data: ok } = await db.from("users").update({ last_spin: today }).eq("tg_id", u.id)
    .or(`last_spin.is.null,last_spin.lt.${today}`).select("tg_id");
  if (!ok?.length) return json({ error: "Колесо уже крутил сегодня. Приходи завтра!" }, 400);
  const total = WHEEL.reduce((s, x) => s + x.w, 0);
  let x = Math.random() * total, sector = 0;
  for (let i = 0; i < WHEEL.length; i++) { x -= WHEEL[i].w; if (x <= 0) { sector = i; break; } }
  const w = WHEEL[sector];
  if (w.kind === "coins") {
    await db.rpc("grant_cards", { u: u.id, ids: [], add_coins: w.n });
    return json({ ok: true, sector, coins: w.n, cards: [] });
  }
  const allowed = w.r === "epic" ? ["epic", "legend"] : w.r === "rare" ? RARE_UP : Object.keys(WEIGHTS);
  const pool = await cards();
  return json({ ok: true, sector, coins: 0, cards: await give(u.id, [pick(pool, allowed)].filter(Boolean), 0) });
}

async function gameStart(u: TgUser, game: string) {
  if (game !== "pairs") return json({ error: "unknown game" }, 400);
  await upsertUser(u);
  const day = mskDay();
  const { data: g } = await db.from("game_days").select("plays,wins").eq("tg_id", u.id).eq("day", day).eq("game", game).maybeSingle();
  await db.from("game_days").upsert({ tg_id: u.id, day, game, plays: (g?.plays || 0) + 1, wins: g?.wins || 0, started_at: new Date().toISOString() });
  return json({ ok: true, wins: g?.wins || 0, left: Math.max(0, GAME_WINS - (g?.wins || 0)) });
}

async function gameWin(u: TgUser, game: string) {
  const day = mskDay();
  const { data: g } = await db.from("game_days").select("wins,started_at").eq("tg_id", u.id).eq("day", day).eq("game", game).maybeSingle();
  if (!g?.started_at) return json({ error: "Игра не начата" }, 400);
  if (Date.now() - new Date(g.started_at).getTime() < 8000) return json({ error: "Слишком быстро!" }, 400);
  if (g.wins >= GAME_WINS) {
    await db.from("game_days").update({ started_at: null }).eq("tg_id", u.id).eq("day", day).eq("game", game);
    return json({ ok: true, coins: 0, left: 0 });
  }
  const { data: upd } = await db.from("game_days").update({ wins: g.wins + 1, started_at: null })
    .eq("tg_id", u.id).eq("day", day).eq("game", game).eq("wins", g.wins).select("wins");
  if (!upd?.length) return json({ ok: true, coins: 0, left: 0 });
  await db.rpc("grant_cards", { u: u.id, ids: [], add_coins: GAME_COIN });
  return json({ ok: true, coins: GAME_COIN, left: GAME_WINS - g.wins - 1 });
}

async function craft(u: TgUser, id: string) {
  const pool = await cards();
  const c = pool.find((x) => x.id === String(id));
  if (!c || !NEXT[c.rarity]) return json({ error: "Эту карточку обменять нельзя" }, 400);
  const { data: ok } = await db.rpc("spend_dupes", { u: u.id, c: c.id, n: 3 });
  if (!ok) return json({ error: "Нужно 3 лишних копии (×4 в коллекции)" }, 400);
  const have = new Set(((await db.from("user_cards").select("card_id").eq("tg_id", u.id)).data || []).map((r) => r.card_id));
  const up = pool.filter((x) => x.rarity === NEXT[c.rarity]);
  const fresh = up.filter((x) => !have.has(x.id));                // сперва те, которых ещё нет
  const list = fresh.length ? fresh : up;
  return json({ ok: true, cards: await give(u.id, [list[Math.floor(Math.random() * list.length)]], 0) });
}

async function setClaim(u: TgUser, channel: string) {
  const need = (await cards()).filter((c) => c.channel === String(channel)).map((c) => c.id);
  if (!need.length) return json({ error: "Нет такого набора" }, 400);
  const have = new Set(((await db.from("user_cards").select("card_id").eq("tg_id", u.id).in("card_id", need)).data || []).map((r) => r.card_id));
  if (need.some((id) => !have.has(id))) return json({ error: "Набор ещё не собран" }, 400);
  const ins = await db.from("set_claims").insert({ tg_id: u.id, channel: String(channel) });
  if (ins.error) return json({ error: "Награда за этот набор уже получена" }, 409);
  return json({ ok: true, coins: SET_COINS, cards: await give(u.id, await roll(1, true), SET_COINS) });
}

const BOSS_HOUR = 12;           // во сколько по Москве бот рассказывает всем о новом боссе
const appUrl = (path: string) => new URL(path, APP.endsWith("/") ? APP : APP + "/").toString();
async function announceBoss() {
  const mskHour = new Date(Date.now() + 3 * 3600e3).getUTCHours();
  if (mskHour < BOSS_HOUR) return 0;
  const b = await bossToday();
  if (!b || b.defeated_at) return 0;
  const { data: mark } = await db.from("bosses").update({ announced_at: new Date().toISOString() }).eq("day", b.day)
    .is("announced_at", null).select("day");
  if (!mark?.length) return 0;                                        // уже разослано (или рассылает другой тик)
  const card = (await cards()).find((c) => c.id === b.card_id);
  if (!card) return 0;
  const { data: users } = await db.from("users").select("tg_id").eq("notify", true).eq("blocked", false).limit(5000);
  const text = `⚔️ Новый босс дня — «${card.name}»!\n\nБьём его все вместе до полуночи. Победим — каждый, кто нанёс от ${BOSS_MIN_HITS} ударов, получит эту карточку себе в коллекцию.\n\nЗаходи и жми по боссу 👇`;
  const reply_markup = { inline_keyboard: [[{ text: "⚔️ Бить босса", web_app: { url: `${APP}?tab=games` } }]] };
  let sent = 0;
  for (const [i, us] of (users || []).entries()) {
    let r: any = await tg("sendPhoto", { chat_id: us.tg_id, photo: appUrl(`boss/${card.id}.jpg`), caption: text, reply_markup });
    if (!r?.ok && r?.error_code !== 403) r = await tg("sendMessage", { chat_id: us.tg_id, text, reply_markup });
    if (r?.ok) sent++;
    else if (r?.error_code === 403) await db.from("users").update({ blocked: true }).eq("tg_id", us.tg_id);
    if (i % 25 === 24) await new Promise((res) => setTimeout(res, 1100));
  }
  return sent;
}

// RETIKO: вопросы викторины по сценарию серии
async function quizSave(v: any) {
  const qs = Array.isArray(v?.questions) ? v.questions : [];
  const ok = qs.length >= 2 && qs.length <= 5 && qs.every((x: any) => typeof x?.q === "string" && Array.isArray(x?.a) && x.a.length === 4 &&
    x.a.every((a: any) => typeof a === "string") && Number.isInteger(x.right) && x.right >= 0 && x.right < 4);
  if (!v?.id || !ok) return json({ error: "bad quiz" }, 400);
  const clean = qs.map((x: any) => ({ q: x.q.slice(0, 160), a: x.a.map((a: string) => a.slice(0, 80)), right: x.right }));
  const { error } = await db.from("quizzes").upsert({ video_id: String(v.id), questions: clean });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

// ---------------------------------------------------------------- RETIKO
// при сборке видео: выдать уникальный код серии (повторный вызов с тем же id вернёт тот же код)
async function reserve(v: any) {
  if (!v?.id || !v?.channel) return json({ error: "bad video" }, 400);
  const { data: old } = await db.from("videos").select("code").eq("id", String(v.id)).maybeSingle();
  if (old) return json({ ok: true, code: old.code });
  for (let i = 0; i < 20; i++) {
    const code = String(10000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90000));
    const { error } = await db.from("videos").insert({ id: String(v.id), channel: String(v.channel), title: String(v.title || "").slice(0, 200), code });
    if (!error) return json({ ok: true, code });
  }
  return json({ error: "no free code" }, 500);
}

// после выкладки: ссылки и время выхода (published_at — время выхода на YouTube, epoch секунд)
async function publish(v: any) {
  if (!v?.id || !v?.title) return json({ error: "bad video" }, 400);
  const patch: Record<string, unknown> = { title: String(v.title).slice(0, 200) };
  for (const k of ["yt_url", "vk_url", "rt_url", "thumb_url"]) if (v[k]) patch[k] = v[k];
  if (v.published_at) patch.published_at = new Date(v.published_at * 1000).toISOString();
  const { data, error } = await db.from("videos").update(patch).eq("id", String(v.id)).select("code");
  if (error) return json({ error: error.message }, 500);
  if (!data?.length) return json({ error: "код серии не был зарезервирован" }, 404);
  return json({ ok: true, code: data[0].code });
}

async function isPublic(url: string) {
  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url));
    return r.status === 200;
  } catch { return false; }
}

async function tick() {
  const now = new Date();
  const { data: due } = await db.from("videos").select("*").is("notified_at", null).lte("published_at", now.toISOString())
    .gte("published_at", new Date(now.getTime() - 36 * 3600e3).toISOString()).order("published_at").limit(10);
  let sent = 0;
  for (const v of due || []) {
    if (v.yt_url && !(await isPublic(v.yt_url))) continue;          // закрыт / запланирован — ждём следующего тика
    await db.from("videos").update({ notified_at: now.toISOString() }).eq("id", v.id);
    const gap = new Date(now.getTime() - NOTIFY_GAP_H * 3600e3).toISOString();
    const { data: users } = await db.from("users").select("tg_id").eq("notify", true).eq("blocked", false)
      .contains("subs", [v.channel]).or(`last_notify.is.null,last_notify.lt.${gap}`).limit(5000);
    const ytId = ((v.yt_url || "").match(/(?:youtu\.be\/|v=|shorts\/)([\w-]{11})/) || [])[1];
    const thumb = v.thumb_url || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : null);
    if (thumb && !v.thumb_url) await db.from("videos").update({ thumb_url: thumb }).eq("id", v.id);   // превью и в ленте приложения
    for (const [i, us] of (users || []).entries()) {
      const send = (m: string, body: any) => tg(m, body);
      const body: any = {
        chat_id: us.tg_id,
        text: `🆕 Новая серия ${v.channel}!\n«${v.title}»\n\nВ серии спрятан секретный код — смотри внимательно! Введи его здесь и получи карточки 🃏 (пока серия среди 3 новейших — сразу 3)`,
        reply_markup: { inline_keyboard: [[{ text: "▶ Смотреть", web_app: { url: `${APP}?v=${encodeURIComponent(v.id)}` } }]] },
      };
      let r: any = null;
      if (thumb) {                                                    // с превьюшкой серии; не вышло — обычным сообщением
        r = await send("sendPhoto", { chat_id: body.chat_id, photo: thumb, caption: body.text, reply_markup: body.reply_markup });
      }
      if (!r?.ok && r?.error_code !== 403) r = await send("sendMessage", body);
      if (r?.ok) { sent++; await db.from("users").update({ last_notify: now.toISOString() }).eq("tg_id", us.tg_id); }
      else if (r?.error_code === 403) await db.from("users").update({ blocked: true }).eq("tg_id", us.tg_id);
      if (i % 25 === 24) await new Promise((s) => setTimeout(s, 1100));   // лимит Telegram ~30 сообщений/с
    }
  }
  let boss = 0;
  try { boss = await announceBoss(); } catch (_) { /* босс не должен ломать рассылку серий */ }
  return json({ ok: true, videos: (due || []).length, sent, boss });
}

// ---------------------------------------------------------------- вебхук
const openBtn = (text = "🎮 Открыть МультоРетик") => ({ inline_keyboard: [[{ text, web_app: { url: APP } }]] });

async function hook(upd: any) {
  const m = upd.message;
  if (upd.my_chat_member?.new_chat_member?.status === "kicked") {
    await db.from("users").update({ blocked: true }).eq("tg_id", upd.my_chat_member.from.id);
    return;
  }
  if (!m?.from || m.chat?.type !== "private") return;
  const text = String(m.text || "").trim();
  if (text.startsWith("/start")) {
    const ref = Number((text.match(/ref_(\d+)/) || [])[1]) || undefined;
    const user = await upsertUser(m.from, ref);
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_markup: openBtn(),
      text: (user.isNew ? "Привет! Это бот сети МультоРетик 👋\n\n" : "С возвращением! 👋\n\n") +
        "🔔 Пришлю, когда выйдет новая серия.\n🔑 В каждой серии спрятан секретный код из 5 цифр — он может появиться в любой момент! Отправь его сюда или введи в приложении.\n🃏 За коды получаешь карточки ретик-персонажей, а за каждый день входа — ещё одну. Собери всю коллекцию!\n👥 Позови друга — оба получите редкую карточку.",
    });
    return;
  }
  if (text === "/stop") {
    await db.from("users").update({ notify: false }).eq("tg_id", m.from.id);
    await tg("sendMessage", { chat_id: m.chat.id, text: "Уведомления выключены. Включить снова — /start" });
    return;
  }
  if (/^\d[\d\s-]{3,8}\d$/.test(text)) {
    const res = await (await redeem(m.from, text)).json();
    const msg = res.error ? `❌ ${res.error}` :
      `✅ Код принят! «${res.video.title}»\nТебе выпало: ${res.cards.map((c: any) => `${c.name} (${({ common: "обычная", rare: "редкая", epic: "эпическая", legend: "ЛЕГЕНДАРНАЯ" } as any)[c.rarity]})`).join(", ")}\n+${res.coins} монет`;
    await tg("sendMessage", { chat_id: m.chat.id, text: msg, reply_markup: openBtn("🃏 Моя коллекция") });
    return;
  }
  await tg("sendMessage", { chat_id: m.chat.id, text: "Отправь код из конца серии (5 цифр) или открой приложение 👇", reply_markup: openBtn() });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("hook")) {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== HOOK_SECRET) return new Response("no", { status: 401 });
      await hook(await req.json());
      return new Response("ok");
    }
    const body = await req.json();
    if (["reserve", "publish", "tick", "quiz"].includes(body.action)) {
      if (body.key !== PUBLISH_KEY) return json({ error: "key" }, 401);
      if (body.action === "quiz") return await quizSave(body.video);
      return body.action === "reserve" ? await reserve(body.video) : body.action === "publish" ? await publish(body.video) : await tick();
    }
    const u = await verify(body.initData);
    if (!u?.id) return json({ error: "Открой приложение заново из бота" }, 401);
    switch (body.action) {
      case "me": return await me(u);
      case "redeem": return await redeem(u, body.code);
      case "pack": return await pack(u);
      case "subs": return await subs(u, body.subs, body.notify);
      case "quiz_get": return await quizGet(u, body.video);
      case "quiz_answer": return await quizAnswer(u, body.video, body.answers);
      case "boss": return await boss(u);
      case "hit": return await hit(u, body.n);
      case "boss_claim": return await bossClaim(u);
      case "spin": return await spin(u);
      case "game_start": return await gameStart(u, body.game);
      case "game_win": return await gameWin(u, body.game);
      case "craft": return await craft(u, body.card);
      case "set_claim": return await setClaim(u, body.channel);
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
