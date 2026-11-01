// МультоРетик Бот · edge function `bot`
// POST ?hook=1 (вебхук Telegram)      -> /start [ref_<id>], ввод кода сообщением, /stop, блокировка бота
// POST {action:"me", initData}       -> профиль + ежедневный бонус, карточки, лента серий, рейтинг
// POST {action:"redeem", initData, code}
// POST {action:"pack", initData}     -> набор за монеты
// POST {action:"subs", initData, subs, notify}
// POST {action:"reserve", key, video} -> RETIKO при сборке видео получает код серии
// POST {action:"publish", key, video} -> RETIKO после выкладки: ссылки и время выхода
// POST {action:"tick", key}          -> pg_cron: уведомить о сериях, чьё время выхода наступило
import { createClient } from "npm:@supabase/supabase-js@2.117.0";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const HOOK_SECRET = Deno.env.get("TG_HOOK_SECRET")!;
const PUBLISH_KEY = Deno.env.get("PUBLISH_KEY")!;
const APP = Deno.env.get("APP_URL")!;                    // адрес мини-приложения (GitHub Pages)
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });

const FRESH_H = 48;            // код «свежий» первые 48 часов — награда больше
const PACK_PRICE = 50;
const DAILY_COINS = 5;
const NOTIFY_GAP_H = 3;        // не чаще одного уведомления в 3 часа
const MAX_BAD_CODES = 8;       // неверных кодов в час
const WEIGHTS: Record<string, number> = { common: 65, rare: 25, epic: 8, legend: 2 };
const RARE_UP = ["rare", "epic", "legend"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
const later = (p: Promise<unknown>) => {
  const rt = (globalThis as any).EdgeRuntime;
  rt?.waitUntil ? rt.waitUntil(p.catch(() => {})) : p.catch(() => {});
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
    await db.from("users").update({ username: u.username || null, name, seen_at: new Date().toISOString(), blocked: false }).eq("tg_id", u.id);
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
  await db.from("users").update({ last_daily: today, streak }).eq("tg_id", user.tg_id);
  const prize = streak % 7 === 0 ? await roll(3, true) : [];          // каждый 7-й день подряд — набор
  const pack = await give(user.tg_id, prize, DAILY_COINS);
  return { streak, coins: DAILY_COINS, pack };
}

async function me(u: TgUser) {
  const user = await upsertUser(u);
  const bonus = await daily(user);
  const [{ data: fresh }, { data: mine }, { data: vids }, { data: top }, { data: done }] = await Promise.all([
    db.from("users").select("coins,streak,subs,notify").eq("tg_id", u.id).single(),
    db.from("user_cards").select("card_id,count").eq("tg_id", u.id),
    db.from("videos").select("id,channel,title,yt_url,vk_url,rt_url,thumb_url,published_at")
      .lte("published_at", new Date().toISOString()).order("published_at", { ascending: false }).limit(40),
    db.from("leaderboard").select("tg_id,name,unique_cards").limit(20),
    db.from("redemptions").select("video_id").eq("tg_id", u.id),
  ]);
  const { count: friends } = await db.from("users").select("tg_id", { count: "exact", head: true }).eq("ref_by", u.id);
  return json({
    me: { id: u.id, name: user.name, ...fresh, friends: friends || 0 },
    bonus, cards: await cards(), mine: mine || [], videos: vids || [],
    redeemed: (done || []).map((r) => r.video_id), top: top || [],
    packPrice: PACK_PRICE,
  });
}

async function redeem(u: TgUser, raw: string) {
  const code = String(raw || "").replace(/\D/g, "");
  if (code.length !== 5) return json({ error: "Код — это 5 цифр из конца серии" }, 400);
  const since = new Date(Date.now() - 3600e3).toISOString();
  const { count: bad } = await db.from("code_attempts").select("tg_id", { count: "exact", head: true }).eq("tg_id", u.id).gte("at", since);
  if ((bad || 0) >= MAX_BAD_CODES) return json({ error: "Слишком много неверных кодов. Попробуй через час" }, 429);
  const { data: v } = await db.from("videos").select("id,channel,title,published_at").eq("code", code).maybeSingle();
  if (!v || !v.published_at) {
    await db.from("code_attempts").insert({ tg_id: u.id });
    return json({ error: "Такого кода нет. Проверь цифры в конце серии" }, 404);
  }
  const user = await upsertUser(u);
  const fresh = Date.now() - new Date(v.published_at).getTime() < FRESH_H * 3600e3;
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
  const patch = {
    title: String(v.title).slice(0, 200), yt_url: v.yt_url || null, vk_url: v.vk_url || null, rt_url: v.rt_url || null,
    thumb_url: v.thumb_url || null,
    published_at: v.published_at ? new Date(v.published_at * 1000).toISOString() : new Date().toISOString(),
  };
  const { data, error } = await db.from("videos").update(patch).eq("id", String(v.id)).select("code");
  if (error) return json({ error: error.message }, 500);
  if (!data?.length) return json({ error: "код серии не был зарезервирован" }, 404);
  return json({ ok: true, code: data[0].code });
}

async function tick() {
  const now = new Date();
  const { data: due } = await db.from("videos").select("*").is("notified_at", null).lte("published_at", now.toISOString())
    .gte("published_at", new Date(now.getTime() - 12 * 3600e3).toISOString()).order("published_at").limit(5);
  let sent = 0;
  for (const v of due || []) {
    await db.from("videos").update({ notified_at: now.toISOString() }).eq("id", v.id);
    const gap = new Date(now.getTime() - NOTIFY_GAP_H * 3600e3).toISOString();
    const { data: users } = await db.from("users").select("tg_id").eq("notify", true).eq("blocked", false)
      .contains("subs", [v.channel]).or(`last_notify.is.null,last_notify.lt.${gap}`).limit(5000);
    for (const [i, us] of (users || []).entries()) {
      const r = await tg("sendMessage", {
        chat_id: us.tg_id,
        text: `🆕 Новая серия ${v.channel}!\n«${v.title}»\n\nВ конце серии — секретный код. Введи его здесь и получи карточку 🃏 (первые 48 часов — тройной набор)`,
        reply_markup: { inline_keyboard: [[{ text: "▶ Смотреть", web_app: { url: `${APP}?v=${encodeURIComponent(v.id)}` } }]] },
      });
      if (r?.ok) { sent++; await db.from("users").update({ last_notify: now.toISOString() }).eq("tg_id", us.tg_id); }
      else if (r?.error_code === 403) await db.from("users").update({ blocked: true }).eq("tg_id", us.tg_id);
      if (i % 25 === 24) await new Promise((s) => setTimeout(s, 1100));   // лимит Telegram ~30 сообщений/с
    }
  }
  return json({ ok: true, videos: (due || []).length, sent });
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
        "🔔 Пришлю, когда выйдет новая серия.\n🔑 В конце каждой серии есть секретный код из 5 цифр — отправь его сюда или введи в приложении.\n🃏 За коды получаешь карточки ретик-персонажей. Собери всю коллекцию!\n👥 Позови друга — оба получите редкую карточку.",
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
    if (["reserve", "publish", "tick"].includes(body.action)) {
      if (body.key !== PUBLISH_KEY) return json({ error: "key" }, 401);
      return body.action === "reserve" ? await reserve(body.video) : body.action === "publish" ? await publish(body.video) : await tick();
    }
    const u = await verify(body.initData);
    if (!u?.id) return json({ error: "Открой приложение заново из бота" }, 401);
    switch (body.action) {
      case "me": return await me(u);
      case "redeem": return await redeem(u, body.code);
      case "pack": return await pack(u);
      case "subs": return await subs(u, body.subs, body.notify);
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
