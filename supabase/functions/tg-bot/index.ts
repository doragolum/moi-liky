// Telegram-бот «Мої ліки»: нагадування + відмітки кнопками.
// Викликається: 1) Telegram webhook (заголовок X-Telegram-Bot-Api-Secret-Token)
//               2) pg_cron щохвилини (заголовок x-cron-secret, ?action=tick)
//               3) одноразово для налаштування (?action=setup)
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP_URL = Deno.env.get("APP_URL") ?? "https://doragolum.github.io/moi-liky/";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Секрети: з Edge Function secrets, якщо задані, інакше з таблиці app_secrets (доступна лише service role)
let TOKEN = Deno.env.get("TG_BOT_TOKEN") ?? "";
let HOOK_SECRET = Deno.env.get("TG_WEBHOOK_SECRET") ?? "";
let CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
let vapidReady = false;
async function loadSecrets() {
  if (TOKEN && HOOK_SECRET && CRON_SECRET && vapidReady) return;
  const { data } = await sb.from("app_secrets").select("name, value");
  const m = Object.fromEntries((data ?? []).map((r) => [r.name, r.value]));
  TOKEN ||= m.TG_BOT_TOKEN ?? ""; HOOK_SECRET ||= m.TG_WEBHOOK_SECRET ?? ""; CRON_SECRET ||= m.CRON_SECRET ?? "";
  if (!vapidReady && m.VAPID_PUBLIC && m.VAPID_PRIVATE) {
    webpush.setVapidDetails(APP_URL, m.VAPID_PUBLIC, m.VAPID_PRIVATE);
    vapidReady = true;
  }
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
async function pushTo(subs: Sub[], payload: Record<string, unknown>) {
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      ok++;
    } catch (e: any) {
      console.error("push failed", e?.statusCode, e?.body);
      if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);
    }
  }
  return ok;
}
function pushPayload(m: Med, day: string, followup: boolean) {
  const plan = m.plan_time.slice(0, 5);
  return {
    title: followup ? `Ще не відмічено: ${m.name}` : `${m.name} · ${plan}`,
    body: followup ? `План був о ${plan}. Натисни, щоб відмітити.` : `${m.dose_label}${m.note ? " · " + m.note : ""}`,
    tag: `${m.id}|${day}`,
    url: `${APP_URL}?q=${m.id}&d=${day}${followup ? "&f=1" : ""}`,
  };
}

const SITES = ["Живіт ліворуч", "Живіт праворуч", "Стегно ліве", "Стегно праве", "Плече ліве", "Плече праве"];
const WINDOW_AFTER_MIN = 180; // не надсилати нагадування пізніше ніж через 3 год після плану

type Med = {
  id: string; user_id: string; name: string; dose_label: string; dose_options: number[] | null;
  kind: "daily" | "weekly" | "interval"; weekday: number | null; weekdays: number[] | null;
  interval_days: number | null; start_date: string | null; plan_time: string; note: string | null;
  remind_before_min: number; followup_after_min: number; track_sites: boolean; active: boolean;
};

async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return await r.json();
}

const pad = (n: number) => String(n).padStart(2, "0");
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function local(tz: string, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), hm: `${p.hour}:${p.minute}`, dow: DOW[p.weekday] };
}
function dueOn(m: Med, day: string, dow: number) {
  if (!m.active) return false;
  if (m.start_date && day < m.start_date) return false;
  if (m.kind === "daily") return true;
  if (m.kind === "weekly") return (m.weekdays?.length ? m.weekdays : m.weekday != null ? [m.weekday] : []).includes(dow);
  if (m.kind === "interval") {
    const st = m.start_date ?? day; if (day < st) return false;
    const diff = Math.round((Date.parse(day + "T00:00:00Z") - Date.parse(st + "T00:00:00Z")) / 86400000);
    return diff % (m.interval_days || 1) === 0;
  }
  return false;
}
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (x: number) => `${pad(Math.floor(((x % 1440) + 1440) % 1440 / 60))}:${pad(((x % 60) + 60) % 60)}`;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

async function suggestSite(medId: string) {
  const { data } = await sb.from("intakes").select("site").eq("med_id", medId).not("site", "is", null)
    .eq("status", "taken").order("day", { ascending: false }).limit(1);
  const last = data?.[0]?.site;
  return SITES[(last ? SITES.indexOf(last) + 1 : 0) % SITES.length];
}

async function reminderPayload(m: Med, day: string, followup: boolean) {
  const plan = m.plan_time.slice(0, 5);
  let text = followup
    ? `Ти ще не відмітила <b>${esc(m.name)}</b> (план ${plan}). Уже ${m.track_sites ? "зробила" : "випила"}?`
    : `<b>${esc(m.name)}</b> · ${plan}\n${esc(m.dose_label)}${m.note ? " · " + esc(m.note) : ""}`;
  const rows: unknown[][] = [];
  if (m.track_sites) {
    const site = await suggestSite(m.id);
    text += `\nРекомендоване місце: <b>${esc(site.toLowerCase())}</b>`;
    rows.push([{ text: `Зробила · ${site}`, callback_data: `t|${m.id}|${day}|` }]);
    rows.push([{ text: "Інше місце — в додатку", url: APP_URL }]);
  } else if (m.dose_options?.length) {
    rows.push(m.dose_options.map((n) => ({ text: `Прийняла · ${n} таб.`, callback_data: `t|${m.id}|${day}|${n}` })));
  } else {
    rows.push([{ text: "Прийняла", callback_data: `t|${m.id}|${day}|` }]);
  }
  rows.push([{ text: "Через 15 хв", callback_data: `z|${m.id}|${day}|` }, { text: "Пропустити", callback_data: `s|${m.id}|${day}|` }]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

// ---------- cron tick ----------
async function tick() {
  const { data: users } = await sb.from("settings").select("user_id, tz, telegram_chat_id, notify_telegram, notify_push, checkin_reminders, checkin_times");
  let sent = 0;
  for (const u of users ?? []) {
    const tgOn = !!u.telegram_chat_id && u.notify_telegram;
    let subs: Sub[] = [];
    if (u.notify_push) {
      const { data } = await sb.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", u.user_id);
      subs = data ?? [];
    }
    if (!tgOn && !subs.length) continue;
    const L = local(u.tz);

    // нагадування про самопочуття (ранок / день / вечір)
    if (u.checkin_reminders) {
      const SL = [["morning", "ранок"], ["day", "день"], ["evening", "вечір"]];
      const times: string[] = u.checkin_times?.length === 3 ? u.checkin_times : ["10:30", "16:00", "22:30"];
      for (let i = 0; i < 3; i++) {
        const [slot, name] = SL[i]; const t = toMin(times[i]);
        if (L.min < t || L.min > t + 120) continue;
        const { data: has } = await sb.from("checkins").select("id").eq("user_id", u.user_id).eq("day", L.day).eq("slot", slot).maybeSingle();
        if (has) continue;
        const { data: ins } = await sb.from("checkin_reminders").upsert({ user_id: u.user_id, day: L.day, slot }, { onConflict: "user_id,day,slot", ignoreDuplicates: true }).select();
        if (!ins?.length) continue;
        const url = `${APP_URL}?c=${slot}`;
        if (subs.length) sent += await pushTo(subs, { title: "Як самопочуття?", body: `Відміть ${name} — це 30 секунд`, tag: `checkin|${L.day}|${slot}`, url });
        if (tgOn) { await tg("sendMessage", { chat_id: u.telegram_chat_id, text: `Як самопочуття — ${name}? Відміть за 30 секунд.`, reply_markup: { inline_keyboard: [[{ text: "Відмітити самопочуття", url }]] } }); sent++; }
      }
    }

    const { data: meds } = await sb.from("meds").select("*").eq("user_id", u.user_id).eq("active", true);
    const ids = (meds ?? []).map((m) => m.id);
    if (!ids.length) continue;
    const { data: ints } = await sb.from("intakes").select("med_id").in("med_id", ids).eq("day", L.day);
    const done = new Set((ints ?? []).map((r) => r.med_id));

    for (const m of (meds ?? []) as Med[]) {
      if (done.has(m.id)) continue;
      if (!dueOn(m, L.day, L.dow)) continue;
      const plan = toMin(m.plan_time.slice(0, 5));
      if (L.min > plan + WINDOW_AFTER_MIN) continue;
      let kind: "remind" | "followup" | null = null;
      if (m.followup_after_min > 0 && L.min >= plan + m.followup_after_min) kind = "followup";
      else if (L.min >= plan - m.remind_before_min) kind = "remind";
      if (!kind) continue;
      // спершу «бронюємо» запис у журналі, щоб не надіслати двічі
      const { data: ins } = await sb.from("reminders_log").upsert({ med_id: m.id, day: L.day, kind }, { onConflict: "med_id,day,kind", ignoreDuplicates: true }).select();
      if (!ins?.length) continue;
      if (kind === "followup") {
        // якщо звичайне нагадування ще не йшло (напр. щойно підключилась) — не дублюємо
        await sb.from("reminders_log").upsert({ med_id: m.id, day: L.day, kind: "remind" }, { onConflict: "med_id,day,kind", ignoreDuplicates: true });
      }
      if (subs.length) sent += await pushTo(subs, pushPayload(m, L.day, kind === "followup"));
      if (tgOn) {
        const p = await reminderPayload(m, L.day, kind === "followup");
        const r = await tg("sendMessage", { chat_id: u.telegram_chat_id, parse_mode: "HTML", ...p });
        if (r.ok) { sent++; await sb.from("reminders_log").update({ tg_message_id: r.result.message_id }).eq("med_id", m.id).eq("day", L.day).eq("kind", kind); }
      }
    }

    // відкладені («через 15 хв»)
    const { data: sn } = await sb.from("snoozes").select("*").in("med_id", ids).eq("sent", false).lte("due_at", new Date().toISOString());
    for (const s of sn ?? []) {
      await sb.from("snoozes").update({ sent: true }).eq("id", s.id);
      const { data: has } = await sb.from("intakes").select("id").eq("med_id", s.med_id).eq("day", s.day).maybeSingle();
      if (has) continue;
      const m = (meds as Med[]).find((x) => x.id === s.med_id)!;
      if (subs.length) sent += await pushTo(subs, pushPayload(m, s.day, true));
      if (tgOn) {
        const p = await reminderPayload(m, s.day, true);
        await tg("sendMessage", { chat_id: u.telegram_chat_id, parse_mode: "HTML", ...p });
        sent++;
      }
    }
  }
  return { ok: true, sent };
}

// ---------- telegram updates ----------
async function userByChat(chatId: number) {
  const { data } = await sb.from("settings").select("*").eq("telegram_chat_id", chatId).maybeSingle();
  return data;
}

async function todaySummary(st: { user_id: string; tz: string }) {
  const L = local(st.tz);
  const { data: meds } = await sb.from("meds").select("*").eq("user_id", st.user_id).eq("active", true).order("sort");
  const { data: ints } = await sb.from("intakes").select("*").eq("user_id", st.user_id).eq("day", L.day);
  const lines = ((meds ?? []) as Med[]).filter((m) => dueOn(m, L.day, L.dow)).map((m) => {
    const r = (ints ?? []).find((x) => x.med_id === m.id);
    const st2 = !r ? "ще ні" : r.status === "skipped" ? "пропуск" : "✓ " + local(st.tz, new Date(r.taken_at)).hm;
    return `• ${esc(m.name)} (${m.plan_time.slice(0, 5)}) — ${st2}`;
  });
  return `<b>Сьогодні</b>\n${lines.join("\n") || "Нічого не заплановано"}`;
}

async function onMessage(msg: any) {
  const chatId = msg.chat.id as number;
  const text = (msg.text ?? "").trim();
  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (code) {
      const { data: st } = await sb.from("settings").select("*").eq("link_code", code).maybeSingle();
      if (st) {
        await sb.from("settings").update({ telegram_chat_id: chatId }).eq("user_id", st.user_id);
        await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: "Підключено! Тепер нагадування приходитимуть сюди, а кнопки одразу відмічатимуть прийом у додатку.\n\n/today — що вже прийнято сьогодні" });
        return;
      }
    }
    const st = await userByChat(chatId);
    await tg("sendMessage", { chat_id: chatId, text: st ? "Ти вже підключена. /today — статус на сьогодні." : "Щоб підключити бота, відкрий додаток → «Мої ліки» → «Підключити Telegram»." });
    return;
  }
  const st = await userByChat(chatId);
  if (!st) { await tg("sendMessage", { chat_id: chatId, text: "Цей бот приватний." }); return; }
  if (text.startsWith("/today") || text.startsWith("/status")) {
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: await todaySummary(st), reply_markup: { inline_keyboard: [[{ text: "Відкрити додаток", url: APP_URL }]] } });
    return;
  }
  await tg("sendMessage", { chat_id: chatId, text: "Я надсилаю нагадування й приймаю відмітки кнопками. /today — статус на сьогодні.", reply_markup: { inline_keyboard: [[{ text: "Відкрити додаток", url: APP_URL }]] } });
}

async function onCallback(cq: any) {
  const chatId = cq.message?.chat?.id as number;
  const [act, medId, day, doseStr] = String(cq.data ?? "").split("|");
  const st = await userByChat(chatId);
  if (!st) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Немає доступу" }); return; }
  const { data: m } = await sb.from("meds").select("*").eq("id", medId).eq("user_id", st.user_id).maybeSingle();
  if (!m) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Не знайдено" }); return; }
  const L = local(st.tz);
  const orig = cq.message?.text ? esc(cq.message.text) : esc(m.name);
  const finish = async (line: string, toastText: string) => {
    await tg("editMessageText", { chat_id: chatId, message_id: cq.message.message_id, parse_mode: "HTML", text: `${orig}\n\n${line}`, reply_markup: { inline_keyboard: [[{ text: "Відкрити додаток", url: APP_URL }]] } });
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: toastText });
  };

  if (act === "z") {
    const due = new Date(Date.now() + 15 * 60000);
    await sb.from("snoozes").insert({ med_id: m.id, day, due_at: due.toISOString() });
    await finish(`⏰ Нагадаю о ${local(st.tz, due).hm}`, "Нагадаю через 15 хв");
    return;
  }

  const { data: existing } = await sb.from("intakes").select("*").eq("med_id", m.id).eq("day", day).maybeSingle();
  if (existing) {
    const t = existing.status === "skipped" ? "пропуск" : "о " + local(st.tz, new Date(existing.taken_at)).hm;
    await finish(`Вже відмічено: ${t}`, "Вже відмічено");
    return;
  }

  if (act === "s") {
    await sb.from("intakes").insert({ user_id: st.user_id, med_id: m.id, day, status: "skipped", source: "telegram" });
    await finish("Записала як пропуск. Коментар можна додати в додатку.", "Пропуск записано");
    return;
  }

  if (act === "t") {
    const now = new Date();
    const site = m.track_sites ? await suggestSite(m.id) : null;
    const dose = doseStr ? Number(doseStr) : null;
    const { error } = await sb.from("intakes").insert({ user_id: st.user_id, med_id: m.id, day, status: "taken", taken_at: now.toISOString(), dose, site, source: "telegram" });
    if (error) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Помилка, спробуй у додатку" }); return; }
    let line = `✅ Відмічено о ${L.hm}` + (dose ? ` · ${dose} таб.` : "") + (site ? ` · ${esc(site)}` : "");
    if (/до їжі/.test(m.note ?? "")) line += `\nЇсти можна з ${fromMin(L.min + 120)}`;
    await finish(line, "Відмічено");
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
}

// ---------- server ----------
Deno.serve(async (req) => {
  await loadSecrets();
  if (!CRON_SECRET || !HOOK_SECRET) return new Response("not configured", { status: 500 });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action && req.headers.get("x-cron-secret") === CRON_SECRET) {
    if (action === "tick") return Response.json(await tick());
    if (action === "testpush") {
      const { data } = await sb.from("push_subscriptions").select("id, endpoint, p256dh, auth");
      const n = await pushTo(data ?? [], { title: "Мої ліки", body: "Тестове сповіщення — усе працює.", tag: "test", url: APP_URL });
      return Response.json({ subs: data?.length ?? 0, delivered: n });
    }
    if (action === "testquick") {
      const { data: m } = await sb.from("meds").select("*").eq("name", url.searchParams.get("name") ?? "").maybeSingle();
      const { data } = await sb.from("push_subscriptions").select("id, endpoint, p256dh, auth");
      if (!m) return Response.json({ error: "no med" });
      const n = await pushTo(data ?? [], pushPayload(m as Med, local("Europe/Amsterdam").day, false));
      return Response.json({ delivered: n });
    }
    if (action === "setup") {
      const me = await tg("getMe", {});
      const hook = await tg("setWebhook", { url: `${SB_URL}/functions/v1/tg-bot`, secret_token: HOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
      const cmds = await tg("setMyCommands", { commands: [{ command: "today", description: "Що вже прийнято сьогодні" }] });
      return Response.json({ me, hook, cmds });
    }
  }

  if (req.headers.get("x-telegram-bot-api-secret-token") === HOOK_SECRET) {
    const upd = await req.json();
    try {
      if (upd.callback_query) await onCallback(upd.callback_query);
      else if (upd.message) await onMessage(upd.message);
    } catch (e) { console.error(e); }
    return new Response("ok");
  }
  return new Response("forbidden", { status: 403 });
});
