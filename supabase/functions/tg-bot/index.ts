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
// Маршрут: main — звичайні нагадування; extra — повтори, пропуски, «можна їсти», залишок; summary — підсумки
type Ctx = { u: any; subs: Sub[]; tgOn: boolean };
async function notify(c: Ctx, cls: "main" | "extra" | "summary", push: Record<string, unknown> | null, tgMsg: Record<string, unknown> | null) {
  const route = c.u.notify_route || "push_main";
  const canPush = c.subs.length > 0 && !!push, canTg = c.tgOn && !!tgMsg;
  let usePush = false, useTg = false;
  if (route === "both") { usePush = canPush; useTg = canTg; }
  else if (route === "tg_main") { useTg = canTg; usePush = !useTg && canPush; }
  else { // push_main
    if (cls === "main") { usePush = canPush; useTg = !usePush && canTg; }
    else { useTg = canTg; usePush = !useTg && canPush; }
  }
  let n = 0;
  if (usePush) n += await pushTo(c.subs, push!);
  if (useTg) { const r = await tg("sendMessage", { chat_id: c.u.telegram_chat_id, ...tgMsg! }); if (r.ok) n++; }
  return n;
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
  stock_count?: number | null; stock_per_dose?: number; stock_unit?: string; stock_set_at?: string | null; stock_alert_days?: number; late_window_days?: number;
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

const fmtNum = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");
function dailyUse(m: Med) {
  const per = Number(m.stock_per_dose ?? 1);
  if (m.kind === "daily") return per;
  if (m.kind === "weekly") return per * ((m.weekdays?.length ? m.weekdays.length : 1) / 7);
  if (m.kind === "interval") return per / (m.interval_days || 1);
  return per;
}
async function stockInfo(m: Med) {
  if (m.stock_count == null) return null;
  let q = sb.from("intakes").select("dose, taken_at").eq("med_id", m.id).eq("status", "taken");
  if (m.stock_set_at) q = q.gte("taken_at", m.stock_set_at);
  const { data } = await q;
  const used = (data ?? []).reduce((a, r) => a + (m.dose_options?.length && r.dose ? Number(r.dose) : Number(m.stock_per_dose ?? 1)), 0);
  const left = Math.max(0, Number(m.stock_count) - used);
  const du = dailyUse(m);
  return { left, daysLeft: du > 0 ? left / du : null };
}
async function weeklySummary(u: any, meds: Med[], today: string) {
  const end = Date.parse(today + "T00:00:00Z"); const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
  const { data: ints } = await sb.from("intakes").select("*").eq("user_id", u.user_id).gte("day", days[0]).lte("day", today);
  let due = 0, ok = 0; const missed: string[] = [];
  const first = String(u.created_at ?? "").slice(0, 10); const nowMin = local(u.tz).min;
  for (const d of days) {
    if (first && d < first) continue;
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    for (const m of meds) {
      if (!dueOn(m, d, dow)) continue;
      const r = (ints ?? []).find((x) => x.med_id === m.id && x.day === d);
      if (d === today && !r && toMin(m.plan_time.slice(0, 5)) > nowMin) continue;
      due++;
      if (r?.status === "taken") ok++; else missed.push(`${m.name} (${new Intl.DateTimeFormat("uk-UA", { weekday: "short", timeZone: "UTC" }).format(new Date(d + "T00:00:00Z"))})`);
    }
  }
  const { data: water } = await sb.from("water_logs").select("ml, day").eq("user_id", u.user_id).gte("day", days[0]).lte("day", today);
  const wsum = (water ?? []).reduce((a, w) => a + w.ml, 0);
  const { data: cks } = await sb.from("checkins").select("*").eq("user_id", u.user_id).gte("day", days[0]).lte("day", today);
  const sleeps = (cks ?? []).filter((c) => c.slot === "morning" && c.sleep_start && c.sleep_end).map((c) => { const a = toMin(c.sleep_start.slice(0, 5)), b = toMin(c.sleep_end.slice(0, 5)); return (b - a + 1440) % 1440; });
  const sym: Record<string, number> = {}; for (const c of cks ?? []) for (const s of c.symptoms ?? []) sym[s] = (sym[s] ?? 0) + 1;
  const { data: body } = await sb.from("body_logs").select("day, weight_kg").eq("user_id", u.user_id).not("weight_kg", "is", null).order("day", { ascending: false }).limit(2);
  const lines = [`<b>Підсумок тижня</b>`, `Прийоми: ${ok} з ${due}${due ? ` (${Math.round(ok / due * 100)}%)` : ""}`];
  if (missed.length) lines.push(`Не відмічено: ${missed.slice(0, 8).join(", ")}${missed.length > 8 ? "…" : ""}`);
  lines.push(`Вода: в середньому ${fmtNum(wsum / 7 / 1000)} л/день`);
  if (sleeps.length) { const a = sleeps.reduce((x, y) => x + y, 0) / sleeps.length; lines.push(`Сон: в середньому ${Math.floor(a / 60)} год ${Math.round(a % 60)} хв`); }
  if (body?.length) lines.push(`Вага: ${fmtNum(Number(body[0].weight_kg))} кг${body[1] ? ` (${Number(body[0].weight_kg) <= Number(body[1].weight_kg) ? "−" : "+"}${fmtNum(Math.abs(Number(body[0].weight_kg) - Number(body[1].weight_kg)))} кг)` : ""}`);
  const symList = Object.entries(sym).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s.toLowerCase()} ×${n}`);
  lines.push(symList.length ? `Самопочуття: ${symList.join(", ")}` : `Самопочуття: без скарг`);
  for (const m of meds) { const st = await stockInfo(m); if (st && st.daysLeft != null && st.daysLeft <= (m.stock_alert_days ?? 7)) lines.push(`Закінчується: ${esc(m.name)} — ~${Math.floor(st.daysLeft)} дн.`); }
  return lines.join("\n");
}

// ---------- cron tick ----------
async function tick() {
  const { data: users } = await sb.from("settings").select("*");
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
    const C: Ctx = { u, subs, tgOn };

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
        sent += await notify(C, "main", { title: "Як самопочуття?", body: `Відміть ${name} — це 30 секунд`, tag: `checkin|${L.day}|${slot}`, url },
          { text: `Як самопочуття — ${name}? Відміть за 30 секунд.`, reply_markup: { inline_keyboard: [[{ text: "Відмітити самопочуття", url }]] } });
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
      const p = await reminderPayload(m, L.day, kind === "followup");
      sent += await notify(C, kind === "followup" ? "extra" : "main", pushPayload(m, L.day, kind === "followup"), { parse_mode: "HTML", ...p });
    }

    // пропущені дози, які ще можна зробити (late_window_days) — одне нагадування на день у плановий час
    for (const m of (meds ?? []) as (Med & { late_window_days?: number })[]) {
      const w = m.late_window_days || 0; if (!w || m.kind === "daily") continue;
      if (dueOn(m, L.day, L.dow)) continue;
      const plan = toMin(m.plan_time.slice(0, 5));
      if (L.min < plan - m.remind_before_min || L.min > plan + WINDOW_AFTER_MIN) continue;
      const base = Date.parse(L.day + "T00:00:00Z");
      for (let i = 1; i <= w; i++) {
        const dt = new Date(base - i * 86400000); const d = dt.toISOString().slice(0, 10);
        if (!dueOn(m, d, dt.getUTCDay())) continue;
        const { data: has } = await sb.from("intakes").select("id").eq("med_id", m.id).eq("day", d).maybeSingle();
        if (has) break;
        const { data: ins } = await sb.from("reminders_log").upsert({ med_id: m.id, day: L.day, kind: "late" }, { onConflict: "med_id,day,kind", ignoreDuplicates: true }).select();
        if (!ins?.length) break;
        const left = w - i;
        const dn = new Intl.DateTimeFormat("uk-UA", { weekday: "long", timeZone: "UTC" }).format(dt);
        const when = left === 0 ? "лише сьогодні" : `сьогодні або ще ${left} дн.`;
        const p = await reminderPayload(m, d, true);
        p.text = `<b>${esc(m.name)}</b>: доза за ${dn} не відмічена. Можна зробити ${when}, потім краще пропустити.`;
        sent += await notify(C, "extra", { title: `Пропущено: ${m.name}`, body: `Доза за ${dn}. Можна зробити ${when}.`, tag: `${m.id}|${d}`, url: `${APP_URL}?q=${m.id}&d=${d}&f=1` }, { parse_mode: "HTML", ...p });
        break;
      }
    }

    // відкладені («через 15 хв»)
    const { data: sn } = await sb.from("snoozes").select("*").in("med_id", ids).eq("sent", false).lte("due_at", new Date().toISOString());
    for (const s of sn ?? []) {
      await sb.from("snoozes").update({ sent: true }).eq("id", s.id);
      const { data: has } = await sb.from("intakes").select("id").eq("med_id", s.med_id).eq("day", s.day).maybeSingle();
      if (has) continue;
      const m = (meds as Med[]).find((x) => x.id === s.med_id);
      if (!m) continue;
      const p = await reminderPayload(m, s.day, true);
      sent += await notify(C, "extra", pushPayload(m, s.day, true), { parse_mode: "HTML", ...p });
    }

    // «можна їсти» через 2 год після ліків «до їжі»
    if (u.eat_reminder) {
      for (const m of (meds ?? []) as Med[]) {
        if (!/до їжі/.test(m.note ?? "")) continue;
        const { data: r } = await sb.from("intakes").select("taken_at").eq("med_id", m.id).eq("day", L.day).eq("status", "taken").maybeSingle();
        if (!r?.taken_at) continue;
        const mins = (Date.now() - Date.parse(r.taken_at)) / 60000;
        if (mins < 120 || mins > 240) continue;
        const { data: ins } = await sb.from("reminders_log").upsert({ med_id: m.id, day: L.day, kind: "eat" }, { onConflict: "med_id,day,kind", ignoreDuplicates: true }).select();
        if (!ins?.length) continue;
        sent += await notify(C, "extra", { title: "Можна їсти", body: `Минуло 2 години після ${m.name}.`, tag: `eat|${L.day}`, url: APP_URL }, { text: `Можна їсти — минуло 2 години після ${m.name}.` });
      }
    }

    // залишок закінчується (раз на 3 дні, у проміжку 12:00–14:00)
    if (L.min >= 720 && L.min <= 840) {
      for (const m of (meds ?? []) as Med[]) {
        const st = await stockInfo(m); if (!st || st.daysLeft == null || st.daysLeft > (m.stock_alert_days ?? 7)) continue;
        const since = new Date(Date.parse(L.day + "T00:00:00Z") - 2 * 86400000).toISOString().slice(0, 10);
        const { data: recent } = await sb.from("reminders_log").select("id").eq("med_id", m.id).eq("kind", "stock").gte("day", since).limit(1);
        if (recent?.length) continue;
        await sb.from("reminders_log").upsert({ med_id: m.id, day: L.day, kind: "stock" }, { onConflict: "med_id,day,kind", ignoreDuplicates: true });
        const msg = `${m.name}: залишилось ${fmtNum(st.left)} ${m.stock_unit} — приблизно на ${Math.max(0, Math.floor(st.daysLeft))} дн. Час купити.`;
        sent += await notify(C, "extra", { title: "Закінчуються ліки", body: msg, tag: `stock|${m.id}`, url: APP_URL }, { text: msg });
      }
    }

    // тижневий підсумок: неділя, 20:00–22:00
    if (u.summary_enabled && L.dow === 0 && L.min >= 1200 && L.min <= 1320) {
      const { data: ins } = await sb.from("checkin_reminders").upsert({ user_id: u.user_id, day: L.day, slot: "summary" }, { onConflict: "user_id,day,slot", ignoreDuplicates: true }).select();
      if (ins?.length) {
        const text = await weeklySummary(u, (meds ?? []) as Med[], L.day);
        sent += await notify(C, "summary", { title: "Підсумок тижня", body: text.replace(/<[^>]+>/g, "").slice(0, 180), tag: `summary|${L.day}`, url: APP_URL },
          { parse_mode: "HTML", text, reply_markup: { inline_keyboard: [[{ text: "Відкрити додаток", url: APP_URL }]] } });
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
    const dose_mg = m.track_sites ? st.mj_dose_mg ?? null : null;
    const { error } = await sb.from("intakes").insert({ user_id: st.user_id, med_id: m.id, day, status: "taken", taken_at: now.toISOString(), dose, dose_mg, site, source: "telegram" });
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
    if (action === "testsummary") {
      const { data: u } = await sb.from("settings").select("*").limit(1).single();
      const { data: meds } = await sb.from("meds").select("*").eq("user_id", u.user_id).eq("active", true);
      return Response.json({ text: await weeklySummary(u, (meds ?? []) as Med[], local(u.tz).day) });
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
