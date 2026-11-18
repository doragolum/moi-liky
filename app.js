import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG } from './config.js';

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const DEFAULT_MEDS = [
  { name: 'Глікопіроніум', dose_label: '2–3 таблетки', dose_options: [2, 3], kind: 'daily', plan_time: '09:30', window_label: '9:00–10:00', note: 'за 2 год до їжі', color: '#e6a700', sort: 1 },
  { name: 'Золофт', dose_label: '2 × 50 мг', kind: 'daily', plan_time: '11:00', note: 'після їжі', color: '#3fa3e0', sort: 2 },
  { name: 'Лактінет', dose_label: '1 таблетка', kind: 'daily', plan_time: '22:00', note: 'щодня в один час', color: '#e66aa8', sort: 3 },
  { name: 'Мунджаро', dose_label: '1 укол', kind: 'weekly', weekday: 6, plan_time: '22:00', note: 'ін’єкція', color: '#6c5ce7', track_sites: true, sort: 4 }
];
const SITES = ['Живіт ліворуч', 'Живіт праворуч', 'Стегно ліве', 'Стегно праве', 'Плече ліве', 'Плече праве'];
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const WD_FULL = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];

const S = {
  user: null, meds: [], intakes: new Map(), settings: null,
  view: 'today', month: null, sel: null, sheet: null, quick: null, toast: null, loading: true
};

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayStr = () => ymd(new Date());
const addMin = (hhmm, mins) => { const [h, m] = hhmm.split(':').map(Number); const x = new Date(); x.setHours(h, m + mins, 0, 0); return hm(x); };
const k = (medId, day) => `${medId}|${day}`;
const WD_SHORT = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const activeMeds = () => S.meds.filter((m) => m.active);
const wdays = (m) => m.weekdays?.length ? m.weekdays : (m.weekday != null ? [m.weekday] : []);
function dueOn(m, s) {
  if (!m.active) return false;
  if (m.start_date && s < m.start_date) return false;
  if (m.kind === 'daily') return true;
  const d = parseYmd(s);
  if (m.kind === 'weekly') return wdays(m).includes(d.getDay());
  if (m.kind === 'interval') {
    const st = m.start_date || s; if (s < st) return false;
    const diff = Math.round((d - parseYmd(st)) / 86400000); return diff % (m.interval_days || 1) === 0;
  }
  return false;
}
// що показувати/рахувати в цей день: заплановане + те, що відмічено, хоч і не за планом
const dayMeds = (s) => S.meds.filter((m) => dueOn(m, s) || S.intakes.get(k(m.id, s)));
function nextDue(m, from = todayStr()) {
  const d = parseYmd(from);
  for (let i = 0; i < 400; i++) { const s = ymd(d); if (dueOn(m, s)) return { day: s, until: i }; d.setDate(d.getDate() + 1); }
  return null;
}
function sinceLabel(start) {
  if (!start) return '';
  const today = todayStr();
  if (start > today) { const d = Math.round((parseYmd(start) - parseYmd(today)) / 86400000); return d === 1 ? 'старт завтра' : `старт через ${d} дн.`; }
  const a = parseYmd(start), b = parseYmd(today);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months--;
  const anchor = new Date(a); anchor.setMonth(a.getMonth() + months);
  const days = Math.round((b - anchor) / 86400000);
  if (months <= 0) return days === 0 ? 'старт сьогодні' : `приймаю ${days + 1} дн.`;
  const y = Math.floor(months / 12), mo = months % 12;
  return 'приймаю ' + [y ? `${y} р.` : '', mo ? `${mo} міс.` : '', days ? `${days} дн.` : ''].filter(Boolean).join(' ');
}
function schedLabel(m) {
  if (m.kind === 'daily') return 'щодня';
  if (m.kind === 'weekly') { const w = wdays(m); return w.length === 7 ? 'щодня' : [1, 2, 3, 4, 5, 6, 0].filter((x) => w.includes(x)).map((x) => WD_SHORT[x]).join(', '); }
  if (m.kind === 'interval') return `кожні ${m.interval_days} дн.`;
  return '';
}
const planHM = (m) => (m.plan_time || '').slice(0, 5);
const fmtDay = (s, opts) => parseYmd(s).toLocaleDateString('uk-UA', opts);

const ICON_PILL = (c) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7Z"/><path d="m8.5 8.5 7 7"/></svg>`;
const ICON_SYR = (c) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 2 4 4"/><path d="m17 7 3-3"/><path d="M19 9 8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5"/><path d="m9 11 4 4"/><path d="m5 19-3 3"/><path d="m14 4 6 6"/></svg>`;
const ICON_CHECK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const tint = (hex) => hex + '22';

// ---------- data ----------
async function loadAll() {
  const [{ data: meds, error: e1 }, { data: ints, error: e2 }, { data: st }] = await Promise.all([
    sb.from('meds').select('*').order('sort'),
    sb.from('intakes').select('*').order('day', { ascending: false }).limit(3000),
    sb.from('settings').select('*').maybeSingle()
  ]);
  if (e1 || e2) throw e1 || e2;
  S.meds = meds || [];
  S.intakes = new Map((ints || []).map((r) => [k(r.med_id, r.day), r]));
  S.settings = st;
  await loadMj();
}

async function ensureSeed() {
  const { data: st } = await sb.from('settings').select('*').maybeSingle();
  if (!st) await sb.from('settings').insert({});
  const { count } = await sb.from('meds').select('id', { count: 'exact', head: true });
  if (!count) {
    const base = { dose_options: null, weekday: null, window_label: null, note: null, track_sites: false };
    const { error } = await sb.from('meds').insert(DEFAULT_MEDS.map((m) => ({ ...base, ...m })));
    if (error) throw error;
  }
}

async function saveIntake(med, day, patch) {
  const row = { med_id: med.id, day, source: 'app', ...patch };
  const prev = S.intakes.get(k(med.id, day));
  S.intakes.set(k(med.id, day), { ...(prev || {}), ...row });
  render();
  const { data, error } = await sb.from('intakes').upsert(row, { onConflict: 'med_id,day' }).select().single();
  if (error) { toast('Не вдалося зберегти: ' + error.message); if (prev) S.intakes.set(k(med.id, day), prev); else S.intakes.delete(k(med.id, day)); render(); return; }
  S.intakes.set(k(med.id, day), data);
  render();
}

async function deleteIntake(med, day) {
  const prev = S.intakes.get(k(med.id, day));
  S.intakes.delete(k(med.id, day));
  render();
  const { error } = await sb.from('intakes').delete().eq('med_id', med.id).eq('day', day);
  if (error) { toast('Не вдалося скасувати'); if (prev) S.intakes.set(k(med.id, day), prev); render(); }
  return prev;
}

function takenAtFor(day, hhmm) {
  const d = parseYmd(day); const [h, m] = hhmm.split(':').map(Number); d.setHours(h, m, 0, 0); return d.toISOString();
}
const timeOf = (r) => r && r.taken_at ? hm(new Date(r.taken_at)) : '';
// час із днем тижня, якщо зроблено не в запланований день (із запізненням)
const whenOf = (r) => { if (!r?.taken_at) return ''; const d = new Date(r.taken_at); return ymd(d) !== r.day ? `${d.toLocaleDateString('uk-UA', { weekday: 'short' })} ${hm(d)}` : hm(d); };
// пропущена доза, яку ще можна зробити (вікно late_window_days)
function overdue(m) {
  const w = m.late_window_days || 0; if (!w || !m.active || m.kind === 'daily') return null;
  const t = parseYmd(todayStr());
  for (let i = 1; i <= w; i++) {
    const d = new Date(t); d.setDate(t.getDate() - i); const s = ymd(d);
    if (dueOn(m, s)) { if (S.intakes.get(k(m.id, s))) return null; return { day: s, left: w - i }; }
  }
  return null;
}
// скільки днів до наступного планового прийому після сьогодні
function daysToNext(m) { const t = new Date(parseYmd(todayStr())); t.setDate(t.getDate() + 1); const n = nextDue(m, ymd(t)); return n ? n.until + 1 : null; }

function lastSite(med) {
  let best = null;
  for (const r of S.intakes.values()) if (r.med_id === med.id && r.site && r.status === 'taken' && (!best || r.day > best.day)) best = r;
  return best;
}
function suggestSite(med) { const l = lastSite(med); return SITES[(l ? SITES.indexOf(l.site) + 1 : 0) % SITES.length]; }

function dayStatus(day) {
  const ms = dayMeds(day); let t = 0, any = 0;
  for (const m of ms) { const r = S.intakes.get(k(m.id, day)); if (r) { any++; if (r.status === 'taken') t++; } }
  return { t, any, n: ms.length };
}

function startDay() {
  const c = S.settings?.created_at ? ymd(new Date(S.settings.created_at)) : todayStr();
  let first = c;
  for (const r of S.intakes.values()) if (r.day < first) first = r.day;
  return first;
}

// ---------- push notifications ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const P = { sub: null };
const b64u = (s) => { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
async function checkPush() {
  if (!pushSupported()) return;
  try { const reg = await navigator.serviceWorker.ready; P.sub = await reg.pushManager.getSubscription(); } catch (_) {}
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Дозвіл не надано'); render(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(CONFIG.vapidPublicKey) });
    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent }, { onConflict: 'endpoint' });
    if (error) throw error;
    P.sub = sub;
    if (!S.settings.notify_push) await updateSettings({ notify_push: true });
    reg.showNotification('Мої ліки', { body: 'Сповіщення увімкнено — тепер нагадування приходитимуть сюди.', icon: 'icons/icon-192.png', tag: 'enabled' });
    render();
  } catch (e) { toast('Не вдалося увімкнути: ' + (e.message || e)); }
}
async function disablePush() {
  const sub = P.sub;
  if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); try { await sub.unsubscribe(); } catch (_) {} }
  P.sub = null; render(); toast('Сповіщення на цьому телефоні вимкнено');
}
async function updateSettings(patch) {
  Object.assign(S.settings, patch); render();
  const { error } = await sb.from('settings').update(patch).eq('user_id', S.user.id);
  if (error) toast('Не вдалося зберегти налаштування');
}

// ---------- toast ----------
let toastTimer;
function toast(text, undo) {
  clearTimeout(toastTimer);
  S.toast = { text, undo };
  renderToast();
  toastTimer = setTimeout(() => { S.toast = null; renderToast(); }, 4000);
}
function renderToast() {
  const t = S.toast;
  $('#toast-root').innerHTML = t ? `<div class="toast" role="status"><span>${esc(t.text)}</span>${t.undo ? '<button data-a="undo">Скасувати</button>' : ''}</div>` : '';
}

// ---------- views ----------
function headerHtml() {
  const d = new Date(); const h = d.getHours();
  const today = todayStr(); const st = dayStatus(today);
  const greet = h < 5 ? 'Доброї ночі' : h < 12 ? 'Доброго ранку' : h < 18 ? 'Добрий день' : 'Добрий вечір';
  const left = st.n - st.any;
  const sum = left === 0 ? 'На сьогодні все відмічено' : `Залишилось: ${left}`;
  const off = (213.6 * (1 - (st.n ? st.any / st.n : 0))).toFixed(1);
  return `<header class="head">
    <div><div class="date">${esc(d.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
    <h1>${greet}</h1><div class="sum">${sum}</div></div>
    <div class="ring" aria-label="Відмічено ${st.any} з ${st.n}"><svg width="80" height="80" viewBox="0 0 84 84" aria-hidden="true">
      <circle cx="42" cy="42" r="34" fill="none" style="stroke:var(--track)" stroke-width="10"/>
      <circle cx="42" cy="42" r="34" fill="none" stroke="#6c5ce7" stroke-width="10" stroke-linecap="round" stroke-dasharray="213.6" stroke-dashoffset="${off}" transform="rotate(-90 42 42)"/>
    </svg><span>${st.any}/${st.n}</span></div></header>`;
}

function weekHtml() {
  const d = new Date(); const dow = (d.getDay() + 6) % 7; const today = todayStr(); const first = startDay();
  return `<div class="week">` + WD.map((l, i) => {
    const x = new Date(d); x.setDate(d.getDate() - dow + i); const s = ymd(x);
    const st = dayStatus(s); let dot = 'transparent';
    if (s < today && s >= first) dot = st.t === st.n ? '#1f8a5b' : st.any ? '#f2b544' : '#f0a58f';
    if (s === today) dot = st.t === st.n ? '#1f8a5b' : st.any ? '#f2b544' : '#c9c2dd';
    const sel = (S.daySel || today) === s;
    return `<button class="wd ${s === today ? 'today' : ''} ${sel && s !== today ? 'sel' : ''}" data-a="wpick" data-day="${s}" aria-pressed="${sel}" aria-label="${esc(fmtDay(s, { weekday: 'long', day: 'numeric', month: 'long' }))}"><span class="l">${l}</span><span class="n">${x.getDate()}</span><span class="dot" style="background:${dot}"></span></button>`;
  }).join('') + `</div>`;
}

function medCardHtml(m, day = todayStr()) {
  const today = todayStr(); const r = S.intakes.get(k(m.id, day));
  const future = day > today, past = day < today;
  const taken = r && r.status === 'taken'; const skipped = r && r.status === 'skipped';
  let sub = `${m.dose_label} · ${m.window_label || planHM(m)}${m.note ? ' · ' + m.note : ''}`;
  let hint = '', hintOk = false;
  if (taken) {
    sub = (m.dose_options?.length && r.dose ? `${r.dose} таблетки` : m.dose_label) + (r.note ? ' · ' + r.note : '');
    if (/до їжі/.test(m.note || '')) { hint = 'Їсти можна з ' + addMin(timeOf(r), 120); hintOk = true; }
  } else if (skipped) {
    sub = 'Пропущено' + (r.note ? ' · ' + r.note : '');
  } else if (!future && /після їжі/.test(m.note || '')) {
    const pre = activeMeds().find((x) => /до їжі/.test(x.note || ''));
    const pr = pre && S.intakes.get(k(pre.id, day));
    hint = pr && pr.status === 'taken' ? `Спершу поїсти (можна з ${addMin(timeOf(pr), 120)})` : 'Спершу поїсти';
  }
  const right = taken ? `<span class="chip ok">${ICON_CHECK}${timeOf(r)}</span>`
    : skipped ? `<span class="chip skip">Пропуск</span>`
    : future ? `<span class="chip plan">${planHM(m)}</span>`
    : past ? `<button class="btn-quick" data-a="open" data-id="${m.id}" data-day="${day}" aria-label="Відмітити ${esc(m.name)}">Відмітити</button>`
    : `<button class="btn-quick" data-a="quick" data-id="${m.id}" aria-label="Відмітити ${esc(m.name)} зараз">Прийняла</button>`;
  return `<div class="card ${taken ? 'taken' : skipped ? 'skipped' : ''}">
    <button class="main" ${future ? 'disabled' : `data-a="open" data-id="${m.id}" data-day="${day}"`} aria-label="Деталі: ${esc(m.name)}">
      <span class="ico" style="background:${tint(m.color)}">${ICON_PILL(m.color)}</span>
      <span class="txt"><span class="nm">${esc(m.name)}</span><span class="sb">${esc(sub)}</span>${hint ? `<span class="hint ${hintOk ? 'ok' : ''}">${esc(hint)}</span>` : ''}</span>
    </button>${right}</div>`;
}

function lastIntake(m) {
  let best = null; for (const r of S.intakes.values()) if (r.med_id === m.id && r.status === 'taken' && (!best || r.day > best.day)) best = r; return best;
}

function injHtml(m, day = todayStr()) {
  const today = todayStr(); const r = S.intakes.get(k(m.id, day));
  const done = r && r.status === 'taken'; const future = day > today;
  const when = day === today ? 'Сьогодні' : fmtDay(day, { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
  let sub, site;
  if (done) { sub = `Зроблено ${whenOf(r)}`; site = r.site || ''; }
  else if (r) { sub = `${when} — пропуск`; site = ''; }
  else { sub = `${when}, ${planHM(m)} · ${m.dose_label}`; site = 'Місце: ' + suggestSite(m).toLowerCase(); }
  return `<div class="inj"><span class="ico">${ICON_SYR('#d8cffc')}</span>
    <span class="txt" style="flex:1"><span class="nm">${esc(m.name)}</span><span class="sb">${esc(sub)}</span>${site ? `<span class="site">${esc(site)}</span>` : ''}</span>
    ${future ? `<span class="chip plan" style="background:#463d66;color:#fff">${planHM(m)}</span>` : `<button class="act ${r ? 'done' : ''}" data-a="open" data-id="${m.id}" data-day="${day}">${r ? 'Деталі' : 'Відмітити'}</button>`}</div>`;
}

function todayView() {
  const today = todayStr(); const day = S.daySel || today;
  const ms = dayMeds(day);
  const pills = ms.filter((m) => !m.track_sites); const inj = ms.filter((m) => m.track_sites);
  const isToday = day === today, future = day > today;
  const title = isToday ? 'Сьогодні' : fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' });
  const tip = isToday ? 'Картка — деталі, кнопка — швидко' : future ? 'План на цей день' : 'Можна відмітити заднім числом';
  const empty = !ms.length ? `<div class="panel"><p>${isToday ? 'Сьогодні' : 'Цього дня'} нічого не заплановано.</p></div>` : '';
  const back = isToday ? '' : '<button class="btn link" data-a="wpick" data-day="">← Повернутись до сьогодні</button>';
  const late = isToday ? activeMeds().map((m) => ({ m, o: overdue(m) })).filter((x) => x.o).map(({ m, o }) => {
    const until = new Date(parseYmd(o.day)); until.setDate(until.getDate() + (m.late_window_days || 0));
    return `<div class="late"><b>${esc(m.name)}: пропущено ${esc(fmtDay(o.day, { weekday: 'long', day: 'numeric', month: 'long' }))}</b>
      <span>Можна зробити ${o.left === 0 ? 'лише сьогодні' : 'до ' + esc(fmtDay(ymd(until), { weekday: 'long' }))} включно. Потім цю дозу краще пропустити.</span>
      <div class="two"><button class="btn" data-a="open" data-id="${m.id}" data-day="${o.day}" data-late="1">${m.track_sites ? 'Зробила зараз' : 'Прийняла зараз'}</button><button class="btn ghost" data-a="lateskip" data-id="${m.id}" data-day="${o.day}">Пропустити дозу</button></div></div>`;
  }).join('') : '';
  return headerHtml() + weekHtml() + late +
    `<div class="sec"><h2>${esc(title)}</h2><span class="tip">${tip}</span></div>
     <div class="list">${pills.map((m) => medCardHtml(m, day)).join('')}</div>` + inj.map((m) => injHtml(m, day)).join('') + empty + back;
}

function historyView() {
  const today = todayStr(); const first = startDay();
  const m0 = S.month || new Date(); const y = m0.getFullYear(), mo = m0.getMonth();
  const lead = (new Date(y, mo, 1).getDay() + 6) % 7; const days = new Date(y, mo + 1, 0).getDate();
  const sel = S.sel || today;
  const legendMeds = S.meds.filter((m) => !m.track_sites && (m.active || [...S.intakes.values()].some((r) => r.med_id === m.id)));
  const hasInj = S.meds.some((m) => m.track_sites);
  let ok = 0, all = 0; const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span></span>');
  for (let n = 1; n <= days; n++) {
    const s = `${y}-${pad(mo + 1)}-${pad(n)}`;
    const inRange = s >= first && s <= today;
    const dm = inRange ? dayMeds(s) : [];
    const dots = dm.filter((m) => !m.track_sites).map((m) => {
      const r = S.intakes.get(k(m.id, s));
      if (r) return r.status === 'taken' ? m.color : '#b9b3c9';
      return s === today ? '#d9d4e3' : '#f0a58f';
    });
    if (inRange && s < today) for (const m of dm) { all++; const r = S.intakes.get(k(m.id, s)); if (r && r.status === 'taken') ok++; }
    const injDone = S.meds.some((m) => { if (!m.track_sites) return false; const r = S.intakes.get(k(m.id, s)); return r && r.status === 'taken'; });
    const injPlan = S.meds.some((m) => m.track_sites && dueOn(m, s)) && s >= today;
    const cls = ['cell', s === today ? 'today' : s < today ? 'past' : 'future', s === sel && s !== today ? 'sel' : '', injDone ? 'inj' : injPlan ? 'injplan' : ''].join(' ');
    cells.push(`<button class="${cls}" data-a="pick" data-day="${s}" ${s > today ? 'disabled' : ''} aria-label="${n} число"><span class="n">${n}</span><span class="ds">${dots.map((c) => `<i style="background:${c}"></i>`).join('')}</span></button>`);
  }
  // streak
  let streak = 0; { const x = new Date(); { const st0 = dayStatus(today); if (st0.t !== st0.n) x.setDate(x.getDate() - 1); }
    while (ymd(x) >= first) { const st = dayStatus(ymd(x)); if (st.t === st.n && st.n) { streak++; x.setDate(x.getDate() - 1); } else break; } }
  const stat = all ? `${Math.round(ok / all * 100)}% · серія ${streak} дн.` : (streak ? `Серія ${streak} дн.` : 'Початок 🌱'.replace('🌱', '').trim());

  const rows = dayMeds(sel).map((m) => {
    const r = S.intakes.get(k(m.id, sel));
    let st, col;
    if (r && r.status === 'taken') { st = whenOf(r) + (r.dose && m.dose_options?.length ? ` · ${r.dose} таб.` : '') + (r.site ? ` · ${r.site}` : ''); col = '#c6f36b'; }
    else if (r) { st = 'пропуск'; col = '#d4cfe6'; }
    else { st = sel === today ? 'ще ні' : 'не відмічено'; col = sel === today ? '#d4cfe6' : '#ffb4a2'; }
    return `<button class="drow" data-a="open" data-id="${m.id}" data-day="${sel}"><span class="r"><i style="background:${m.color}"></i><span class="f">${esc(m.name)}</span><b style="color:${col}">${esc(st)}</b></span>${r && r.note ? `<span class="nt">${esc(r.note)}</span>` : ''}</button>`;
  }).join('');
  const isCur = y === new Date().getFullYear() && mo === new Date().getMonth();

  return headerHtml() +
    `<div class="sec"><div class="mnav"><button data-a="mprev" aria-label="Попередній місяць"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
       <h2>${esc(new Date(y, mo, 1).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' }))}</h2>
       ${isCur ? '' : '<button data-a="mnext" aria-label="Наступний місяць"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>'}</div>
       <span class="stat">${esc(stat)}</span></div>
     <div class="cal"><div class="hd">${WD.map((w) => `<span>${w}</span>`).join('')}</div><div class="gr">${cells.join('')}</div>
       <div class="legend">${legendMeds.map((m) => `<span><i style="background:${m.color}"></i>${esc(m.name)}</span>`).join('')}
       <span><i style="background:#b9b3c9"></i>пропуск</span><span><i style="background:#f0a58f"></i>не відмічено</span>${hasInj ? '<span><i class="sq"></i>укол</span>' : ''}</div></div>
     <div class="detail"><span class="t">${sel === today ? 'Сьогодні, ' : ''}${esc(fmtDay(sel, { weekday: 'long', day: 'numeric', month: 'long' }))}</span>${rows}
       <span class="help">Натисни на рядок, щоб відмітити або змінити.</span></div>`;
}

function medsView() {
  const st = S.settings;
  const linked = !!st?.telegram_chat_id;
  const botLink = CONFIG.botUsername && st?.link_code ? `https://t.me/${CONFIG.botUsername}?start=${st.link_code}` : '';
  const list = S.meds.map((m) => {
    const nx = m.active && m.kind !== 'daily' ? nextDue(m) : null;
    const nxt = nx ? (nx.until === 0 ? ' · сьогодні' : nx.until === 1 ? ' · завтра' : ' · наступний ' + fmtDay(nx.day, { day: 'numeric', month: 'long' })) : '';
    return `<button class="mrow mbtn ${m.active ? '' : 'paused'}" data-a="edopen" data-id="${m.id}"><i style="background:${m.color}"></i><span class="f"><b>${esc(m.name)}${m.active ? '' : ' · на паузі'}</b>
      <small>${esc(m.dose_label)} · ${esc(schedLabel(m))}, ${planHM(m)}${esc(nxt)}</small>
      ${m.start_date ? `<small>з ${esc(fmtDay(m.start_date, { day: 'numeric', month: 'long', year: 'numeric' }))} · ${esc(sinceLabel(m.start_date))}</small>` : ''}
      <small>${m.note ? esc(m.note) + ' · ' : ''}нагадування за ${m.remind_before_min} хв${m.followup_after_min ? `, повтор через ${m.followup_after_min} хв` : ''}</small></span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>`;
  }).join('');
  return `<header class="head"><div><div class="date">Налаштування</div><h1>Мої ліки</h1></div></header>
    <div class="panel"><h3>Розклад</h3><p style="font-size:13px">Натисни на ліки, щоб змінити дозування, час чи періодичність.</p>${list}
      <button class="btn ghost" data-a="ednew">+ Додати ліки</button></div>
    <div class="panel"><h3>Telegram</h3>
      ${linked ? '<p>Підключено. Нагадування приходять у бот, а кнопки в повідомленнях одразу відмічають прийом тут.</p>'
        : botLink ? `<p>Натисни кнопку, відкриється бот — натисни «Start». Після цього нагадування почнуть приходити.</p><a class="btn" href="${botLink}" target="_blank" rel="noopener">Підключити Telegram</a>`
        : '<p>Бот ще налаштовується.</p>'}
    </div>
    <div class="panel"><h3>Куди надсилати нагадування</h3>
      ${pushPanel()}
      <div class="nrow"><span>Telegram<small>${linked ? 'З кнопками «Прийняла», «Через 15 хв»' : 'Ще не підключено — див. нижче'}</small></span>
        ${linked ? `<button class="sw" role="switch" aria-checked="${!!st.notify_telegram}" aria-label="Нагадування в Telegram" data-a="tgtoggle"></button>` : ''}</div>
    </div>
    <div class="panel"><h3>Тема</h3><div class="seg">${[['light', 'Світла'], ['dark', 'Темна'], ['auto', 'Авто']].map(([v, l]) => `<button type="button" class="${getTheme() === v ? 'on' : ''}" data-a="theme" data-v="${v}">${l}</button>`).join('')}</div>
      <p style="font-size:12px">«Авто» — як у налаштуваннях iPhone: вдень світла, ввечері темна, якщо так налаштовано.</p></div>
    <div class="panel"><h3>На головний екран</h3><p>iPhone: Safari → «Поділитися» → «На екран „Додому“». Android: Chrome → ⋮ → «Додати на головний екран».</p></div>
    <div class="panel"><button class="btn ghost" data-a="logout">Вийти з акаунта</button><p style="font-size:12px;text-align:center">Версія ${APP_VERSION}</p></div>`;
}

function pushPanel() {
  const st = S.settings;
  let info = '', ctrl = '';
  if (!pushSupported()) {
    info = isIOS && !isStandalone() ? 'Щоб увімкнути, спершу додай додаток на головний екран і відкрий його з іконки.' : 'Цей браузер не підтримує сповіщення.';
  } else if (Notification.permission === 'denied') {
    info = 'Сповіщення заборонені. Увімкни: Налаштування iPhone → Сповіщення → Мої ліки.';
  } else if (P.sub) {
    info = 'Банер на екрані, навіть коли телефон заблоковано';
    ctrl = `<button class="sw" role="switch" aria-checked="${!!st.notify_push}" aria-label="Сповіщення на телефоні" data-a="pushtoggle"></button>`;
  } else {
    info = 'Банер на екрані, навіть коли телефон заблоковано';
  }
  const row = `<div class="nrow"><span>На цьому телефоні<small>${esc(info)}</small></span>${ctrl}</div>`;
  const btn = pushSupported() && Notification.permission !== 'denied' && !P.sub ? '<button class="btn" data-a="pushon">Увімкнути сповіщення</button>' : '';
  const off = P.sub ? '<button class="btn link" data-a="pushoff">Відʼєднати цей телефон</button>' : '';
  return row + btn + off;
}

function navHtml() {
  const b = (v, label, svg) => `<button class="${S.view === v ? 'on' : ''}" data-a="nav" data-v="${v}">${svg}${label}</button>`;
  return `<nav class="nav">${b('today', 'Сьогодні', '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>')}
    ${b('history', 'Історія', '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>')}
    ${b('mj', 'Мунджаро', '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 2 4 4"/><path d="m17 7 3-3"/><path d="M19 9 8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5"/><path d="m9 11 4 4"/><path d="m5 19-3 3"/></svg>')}
    ${b('meds', 'Мої ліки', '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>')}</nav>`;
}

let loginMode = 'in'; // 'in' | 'up'
function loginView(err = '', info = '') {
  const up = loginMode === 'up';
  return `<form class="login" data-form="login">
    <h1>Мої ліки</h1><p>${up ? 'Створи акаунт — це потрібно лише один раз.' : 'Увійди один раз — телефон запамʼятає.'}</p>
    <div class="seg" role="tablist">
      <button type="button" role="tab" aria-selected="${!up}" class="${up ? '' : 'on'}" data-a="lmode" data-v="in">Вхід</button>
      <button type="button" role="tab" aria-selected="${up}" class="${up ? 'on' : ''}" data-a="lmode" data-v="up">Новий акаунт</button>
    </div>
    <label class="lbl">Email<input type="email" name="email" autocomplete="email" required value="${esc(CONFIG.ownerEmail || '')}"></label>
    <label class="lbl">${up ? 'Придумай пароль (від 6 символів)' : 'Пароль'}<input type="password" name="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="6" required></label>
    ${up ? '<label class="lbl">Повтори пароль<input type="password" name="password2" autocomplete="new-password" minlength="6" required></label>' : ''}
    ${err ? `<div class="err">${esc(err)}</div>` : ''}${info ? `<p>${esc(info)}</p>` : ''}
    <button class="btn" type="submit">${up ? 'Створити акаунт' : 'Увійти'}</button>
  </form>`;
}

// ---------- quick screen (opened from a notification) ----------
const ICON_CLOCK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_CHECK_L = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function openQuickFromUrl(href) {
  let u; try { u = new URL(href || location.href); } catch (_) { return; }
  const cslot = u.searchParams.get('c');
  if (cslot && SLOTS.some((x) => x.id === cslot)) { history.replaceState(null, '', location.pathname); S.sheet = null; renderSheet(); openCheckin(cslot); return; }
  const id = u.searchParams.get('q'); if (!id) return;
  const day = u.searchParams.get('d') || todayStr();
  const late = u.searchParams.get('f') === '1';
  history.replaceState(null, '', location.pathname);
  const m = S.meds.find((x) => x.id === id); if (!m) return;
  S.sheet = null; renderSheet();
  S.quick = { m, day, late, site: m.track_sites ? suggestSite(m) : null, done: null };
  renderQuick();
}

function streakFor(m) {
  let n = 0; const x = new Date(); x.setDate(x.getDate() - 1);
  for (;;) { const r = S.intakes.get(k(m.id, ymd(x))); if (r && r.status === 'taken') { n++; x.setDate(x.getDate() - 1); } else break; }
  return n;
}

function quickInfo(m, day) {
  const lines = [];
  if (/після їжі/.test(m.note || '')) {
    const pre = activeMeds().find((x) => /до їжі/.test(x.note || ''));
    const pr = pre && S.intakes.get(k(pre.id, day));
    lines.push(pr && pr.status === 'taken' ? `${pre.name} о ${timeOf(pr)} → їсти можна з ${addMin(timeOf(pr), 120)}. Спершу поїж.` : 'Спершу поїж — натщесерце краще не приймати.');
  }
  if (/до їжі/.test(m.note || '')) lines.push('Після відмітки покажу, з котрої можна їсти.');
  if (m.kind === 'daily' && !/їжі/.test(m.note || '')) {
    const y = new Date(); y.setDate(y.getDate() - 1); const r = S.intakes.get(k(m.id, ymd(y)));
    const st = streakFor(m);
    lines.push((r && r.status === 'taken' ? `Вчора: ${timeOf(r)}` : 'Вчора не відмічено') + (st > 1 ? ` · без пропусків ${st} дн.` : ''));
  }
  return lines.map((l) => `<span class="info">${esc(l)}</span>`).join('');
}

function renderQuick() {
  const root = $('#quick-root'); const q = S.quick;
  if (!q) { root.innerHTML = ''; return; }
  const { m, day } = q; const r = S.intakes.get(k(m.id, day));
  const plan = planHM(m);
  const ban = q.late ? `Ще не відмічено · план був о ${plan}` : (day === todayStr() ? `Нагадування · план ${plan}` : fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' }));
  let body, acts;
  if (q.done || r) {
    const msg = q.done || (r.status === 'skipped' ? 'Вже відмічено як пропуск' : `Вже відмічено о ${timeOf(r)}` + (r.site ? ` · ${r.site}` : ''));
    body = `<div class="ok">${esc(msg)}</div>`;
    acts = `<button class="p" data-a="qclose">Готово</button>${r ? '<button class="t" data-a="qmore">Змінити або скасувати</button>' : ''}`;
  } else {
    const chips = m.note && !m.track_sites ? `<span class="chipx">${esc(m.note[0].toUpperCase() + m.note.slice(1))}</span>` : '';
    let sites = '';
    if (m.track_sites) {
      const sug = suggestSite(m); const ls = lastSite(m);
      sites = `<div class="lbl">Місце уколу · за чергуванням: ${esc(sug.toLowerCase())}<div class="opts">${SITES.map((s) => `<button class="opt ${q.site === s ? 'on' : ''}" data-a="qsite" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        <span style="font-weight:500;font-size:12px;color:var(--muted)">${ls ? 'Минулого разу: ' + esc(ls.site) + ', ' + esc(fmtDay(ls.day, { day: 'numeric', month: 'long' })) : 'Перший укол — з нього почнеться історія місць'}</span></div>`;
    }
    body = chips + quickInfo(m, day) + sites;
    const now = hm(new Date());
    let main;
    if (m.track_sites) main = `<button class="p" data-a="qtake">${ICON_CHECK_L}Зробила · ${esc(q.site.toLowerCase())}</button>`;
    else if (m.dose_options?.length) main = `<span style="font-size:14px;font-weight:700;color:var(--muted2)">Прийняла зараз · ${now}:</span><div class="two">${m.dose_options.map((n) => `<button class="p" data-a="qtake" data-v="${n}">${n} таблетки</button>`).join('')}</div>`;
    else main = `<button class="p" data-a="qtake">${ICON_CHECK_L}Прийняла зараз · ${now}</button>`;
    acts = `${main}
      ${day === todayStr() ? `<button class="s" data-a="qsnooze">${ICON_CLOCK}Нагадати через 15 хв</button>` : ''}
      <div class="two"><button class="t" data-a="qskip">Пропустити</button><button class="t" data-a="qmore">Інший час / коментар</button></div>`;
  }
  const ico = m.track_sites ? ICON_SYR(m.color) : ICON_PILL(m.color);
  root.innerHTML = `<div class="qk" role="dialog" aria-modal="true" aria-label="${esc(m.name)}"><div class="in">
    <div class="top"><span class="ban ${q.late ? 'late' : ''}">${ICON_CLOCK}${esc(ban)}</span><button class="x" data-a="qclose" aria-label="Закрити"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="box"><div class="hd"><span class="big" style="background:${tint(m.color)}">${ico.replace('width="24" height="24"', 'width="32" height="32"')}</span>
      <span><div class="nm">${esc(m.name)}</div><div class="pl">План ${plan} · ${esc(m.dose_label)}</div></span></div>${body}</div>
    <div class="acts">${acts}</div></div></div>`;
}

let quickTimer;
function quickDone(msg) {
  S.quick.done = msg; renderQuick();
  clearTimeout(quickTimer);
  quickTimer = setTimeout(() => { if (S.quick && S.quick.done === msg) { S.quick = null; renderQuick(); } }, 2500);
}

// ---------- sheet ----------
function openSheet(medId, day, late = false) {
  const m = S.meds.find((x) => x.id === medId); if (!m) return;
  const today = todayStr();
  S.sheet = { m, day, late, edit: false, mode: day === today || late ? 'now' : 'custom', time: day === today ? hm(new Date()) : planHM(m),
    dose: m.dose_options?.[0] ?? null, site: m.track_sites ? suggestSite(m) : null, note: '' };
  const r = S.intakes.get(k(m.id, day));
  if (r) { S.sheet.note = r.note || ''; if (r.dose) S.sheet.dose = r.dose; if (r.site) S.sheet.site = r.site; if (r.taken_at) { S.sheet.time = timeOf(r); S.sheet.mode = 'custom'; } }
  renderSheet();
}

function renderSheet() {
  const sh = S.sheet; const root = $('#sheet-root');
  if (!sh) { root.innerHTML = ''; return; }
  const { m, day } = sh; const today = todayStr();
  const r = S.intakes.get(k(m.id, day));
  const dayLbl = day === today ? 'сьогодні' : fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' });
  let body;
  if (r && !sh.edit) {
    const t = r.status === 'skipped' ? 'Відмічено як пропуск' : `Відмічено ${ymd(new Date(r.taken_at)) !== r.day ? fmtDay(ymd(new Date(r.taken_at)), { weekday: 'long' }) + ' о ' + timeOf(r) + ' (із запізненням)' : 'о ' + timeOf(r)}` + (r.dose && m.dose_options?.length ? ` · ${r.dose} таб.` : '') + (r.site ? ` · ${r.site}` : '');
    body = `<div class="done-box ${r.status === 'skipped' ? 'skip' : ''}">${esc(t)}${r.note ? '<br>' + esc(r.note) : ''}${r.source === 'telegram' ? '<br><small>через Telegram</small>' : ''}</div>
      <button class="btn ghost" data-a="sedit">Змінити</button>
      <button class="btn link" data-a="sdel">Скасувати відмітку</button>`;
  } else {
    const doses = m.dose_options?.length ? `<div class="lbl">Скільки таблеток<div class="opts">${m.dose_options.map((n) => `<button class="opt ${sh.dose === n ? 'on' : ''}" data-a="sdose" data-v="${n}">${n} таблетки</button>`).join('')}</div></div>` : '';
    const sug = m.track_sites ? suggestSite(m) : null; const ls = m.track_sites ? lastSite(m) : null;
    const sites = m.track_sites ? `<div class="lbl">Місце уколу<div class="opts">${SITES.map((s) => `<button class="opt ${sh.site === s ? 'on' : ''}" data-a="ssite" data-v="${esc(s)}">${esc(s)}${s === sug ? '<small>за чергуванням</small>' : ''}</button>`).join('')}</div>
      <span style="font-weight:500;font-size:12px;color:var(--muted)">${ls ? 'Минулого разу: ' + esc(ls.site) + ', ' + esc(fmtDay(ls.day, { day: 'numeric', month: 'long' })) : 'Перший укол — з нього почнеться історія місць'}</span></div>` : '';
    const timeSel = day === today || sh.late
      ? `<div class="opts"><button class="opt ${sh.mode === 'now' ? 'on' : ''}" data-a="smode" data-v="now">Зараз · ${hm(new Date())}</button><button class="opt ${sh.mode === 'custom' ? 'on' : ''}" data-a="smode" data-v="custom">Вказати час</button></div>` : '';
    const timeIn = sh.mode === 'custom' ? `<label class="row">Коли<input type="time" data-in="time" value="${esc(sh.time)}"></label>` : '';
    const tShow = sh.mode === 'now' ? hm(new Date()) : sh.time;
    const gap = sh.late ? daysToNext(m) : null;
    const lateInfo = sh.late ? `<div class="done-box skip">Доза за ${esc(fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' }))}, робиш сьогодні.${gap != null && gap < 3 ? ` Наступна за планом через ${gap} дн. — між уколами має бути щонайменше 3 дні, уточни з лікарем, чи зсунути наступну.` : ''}</div>` : '';
    body = `${lateInfo}${doses}${sites}${timeSel}${timeIn}
      <label class="lbl">Коментар (не обовʼязково)<textarea rows="2" data-in="note" placeholder="Наприклад: поїла раніше, нудило…">${esc(sh.note)}</textarea></label>
      <button class="btn" data-a="ssave">${m.track_sites ? 'Відмітити укол' : 'Прийняла'} · ${tShow}</button>
      <button class="btn link" data-a="sskip">${day === today ? 'Пропускаю сьогодні' : 'Відмітити як пропуск'}</button>`;
  }
  root.innerHTML = `<div class="ov" role="dialog" aria-modal="true" aria-label="${esc(m.name)}"><button class="bg" data-a="sclose" aria-label="Закрити"></button>
    <div class="sh"><span class="grab"></span><div class="shh"><div><div class="ttl">${esc(m.name)}</div><div class="sub">${esc(m.dose_label)} · ${esc(dayLbl)} · план ${planHM(m)}${m.note ? ' · ' + esc(m.note) : ''}</div></div><button class="shx" data-a="sclose" aria-label="Закрити"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>${body}</div></div>`;
}

// ---------- Мунджаро: самопочуття, вода, сон, вага, активність ----------
const SLOTS = [{ id: 'morning', name: 'Ранок' }, { id: 'day', name: 'День' }, { id: 'evening', name: 'Вечір' }];
const SYMPTOMS = ['Нудота', 'Печія / відрижка', 'Здуття', 'Закреп', 'Діарея', 'Біль у животі', 'Блювання'];
const EXERCISES = [['Вставання зі стільця', '2 × 8'], ['Віджимання від стіни', '2 × 8–10'], ['Тяга еспандера', '2 × 10'], ['Сідничний місток', '2 × 10']];
const slotTimes = () => S.settings?.checkin_times?.length === 3 ? S.settings.checkin_times : ['10:30', '16:00', '22:30'];
const litres = (ml) => (Math.round(ml / 100) / 10).toLocaleString('uk-UA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ICON_BACK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';

async function loadMj() {
  const since = new Date(); since.setDate(since.getDate() - 200); const s = ymd(since);
  const [c, w, b, a] = await Promise.all([
    sb.from('checkins').select('*').gte('day', s),
    sb.from('water_logs').select('*').gte('day', s).order('created_at'),
    sb.from('body_logs').select('*').order('day'),
    sb.from('activity_logs').select('*').gte('day', s)
  ]);
  S.mj = { checkins: c.data || [], water: w.data || [], body: b.data || [], activity: a.data || [] };
}
const injMed = () => S.meds.find((m) => m.track_sites && m.active) || S.meds.find((m) => m.track_sites);
function firstInjection(m) {
  let f = null; for (const r of S.intakes.values()) if (r.med_id === m.id && r.status === 'taken' && (!f || r.day < f)) f = r.day; return f;
}
function currentSlot() {
  const now = hm(new Date()); const t = slotTimes();
  if (now >= t[2]) return 'evening'; if (now >= t[1]) return 'day'; return 'morning';
}
const checkinOf = (day, slot) => S.mj.checkins.find((c) => c.day === day && c.slot === slot);
const waterOn = (day) => S.mj.water.filter((w) => w.day === day).reduce((a, w) => a + w.ml, 0);
function sleepMins(c) {
  if (!c?.sleep_start || !c?.sleep_end) return null;
  const toM = (t) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
  let d = toM(c.sleep_end) - toM(c.sleep_start); if (d < 0) d += 1440; return d;
}
const fmtMins = (m) => `${Math.floor(m / 60)} год${m % 60 ? ' ' + (m % 60) + ' хв' : ''}`;
function weekDays() { const d = new Date(); const dow = (d.getDay() + 6) % 7; return [0, 1, 2, 3, 4, 5, 6].map((i) => { const x = new Date(d); x.setDate(d.getDate() - dow + i); return ymd(x); }); }
const activityOn = (day) => S.mj.activity.find((a) => a.day === day && a.done);
const lastBody = (f) => [...S.mj.body].reverse().find((b) => b[f] != null);

function mjHead(title, sub, back = true) {
  return `<header class="head"><div style="display:flex;align-items:center;gap:10px">${back ? `<button class="shx" data-a="mjback" aria-label="Назад">${ICON_BACK}</button>` : ''}<div><div class="date">${esc(sub)}</div><h1>${esc(title)}</h1></div></div></header>`;
}

function mjOverview() {
  const today = todayStr(); const m = injMed(); const st = S.settings || {};
  let prog = '', inj = '';
  if (m) {
    const first = firstInjection(m);
    const dose = String(st.mj_dose_mg ?? 2.5).replace('.', ',');
    if (first) {
      const w = Math.floor((parseYmd(today) - parseYmd(first)) / 604800000) + 1;
      const within = (w - 1) % 4;
      const bars = [0, 1, 2, 3].map((i) => `<span class="wk ${i < within ? 'past' : i === within ? 'cur' : ''}"><i></i>Т${Math.floor((w - 1) / 4) * 4 + i + 1}</span>`).join('');
      prog = `<div class="panel"><div class="row" style="color:var(--ink)"><span style="font-weight:800">Тиждень ${w} · ${dose} мг</span><span style="font-size:12px;color:var(--muted)">з ${esc(fmtDay(first, { day: 'numeric', month: 'long' }))}</span></div>
        <div class="wks">${bars}</div><p style="font-size:12px">${within === 3 ? 'Кінець 4-тижневого етапу — обговори з лікарем, чи підвищувати дозу.' : 'Підвищення дози — лише після рішення лікаря.'}</p></div>`;
    } else {
      const nx = nextDue(m);
      prog = `<div class="panel"><span style="font-weight:800">Старт програми · ${dose} мг</span><p style="font-size:13px">Перший укол: ${nx ? esc(fmtDay(nx.day, { weekday: 'long', day: 'numeric', month: 'long' })) : '—'}. Після нього тут зʼявиться відлік тижнів.</p></div>`;
    }
    const nx = nextDue(m); const r = S.intakes.get(k(m.id, today));
    const sug = suggestSite(m); const ls = lastSite(m);
    const when = r && r.status === 'taken' ? `Зроблено сьогодні о ${timeOf(r)}` : nx ? `${fmtDay(nx.day, { weekday: 'long', day: 'numeric', month: 'long' })} · ${planHM(m)}` : '';
    const badge = r ? '' : nx ? (nx.until === 0 ? 'сьогодні' : nx.until === 1 ? 'завтра' : `через ${nx.until} дн.`) : '';
    inj = `<button class="injbig" ${nx && nx.until === 0 ? `data-a="open" data-id="${m.id}" data-day="${today}"` : 'data-a="noop"'}>
      <span class="row" style="color:#fff"><span style="text-align:left"><b style="display:block;font-size:16px">${r ? 'Укол' : 'Наступний укол'}</b><small style="color:var(--plum-muted);font-size:13px">${esc(when)}</small></span>${badge ? `<span class="bdg">${badge}</span>` : ''}</span>
      <span class="sites">${SITES.map((s) => `<i class="${s === sug && !r ? 'on' : ''}">${esc(s.replace('ліворуч', 'Л').replace('праворуч', 'П').replace('ліве', 'Л').replace('праве', 'П'))}</i>`).join('')}</span>
      <small style="color:var(--plum-muted);font-size:12px;text-align:left">${ls ? 'Минулого разу: ' + esc(ls.site.toLowerCase()) : 'Перший укол — з нього почнеться історія місць'}</small></button>`;
  }
  const goal = st.water_goal_ml || 3000; const wt = waterOn(today);
  const sl = sleepMins(checkinOf(today, 'morning'));
  const lb = lastBody('weight_kg');
  const wd = weekDays(); const act = wd.filter((d) => activityOn(d)).length;
  const done = SLOTS.filter((s) => checkinOf(today, s.id)).length;
  const cs = currentSlot(); const csName = SLOTS.find((s) => s.id === cs).name.toLowerCase();
  const tile = (sub, t, v, s2) => `<button class="tile" data-a="mjsub" data-v="${sub}"><span>${t}</span><b>${v}</b><small>${s2}</small></button>`;
  return `<header class="head"><div><div class="date">${esc(new Date().toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' }))}</div><h1>Мунджаро</h1></div></header>
    ${prog}${inj ? `<div style="margin:12px 22px 0">${inj}</div>` : ''}
    <div class="tiles">
      ${tile('water', 'Вода', `${litres(wt)} / ${litres(goal)} л`, wt >= goal ? 'ціль виконано' : `ще ${litres(goal - wt)} л`)}
      ${tile('water', 'Сон', sl != null ? fmtMins(sl) : '—', sl != null ? ['погано', 'нормально', 'добре'][checkinOf(today, 'morning')?.sleep_quality ?? 1] : 'відміть зранку')}
      ${tile('weight', 'Вага', lb ? `${String(lb.weight_kg).replace('.', ',')} кг` : (st.weight_start ? `${String(st.weight_start).replace('.', ',')} кг` : '—'), st.weight_goal ? `ціль ${String(st.weight_goal).replace('.', ',')}` : 'додай зважування')}
      ${tile('activity', 'Активність', `${act} / 7`, 'днів цього тижня')}
    </div>
    <div style="margin:12px 22px 0"><button class="btn" data-a="mjcheck" data-v="${cs}" style="width:100%;gap:10px">Самопочуття · ${csName} <span class="bdg" style="background:rgba(255,255,255,.2)">${done} з 3</span></button></div>`;
}

function mjWater() {
  const today = todayStr(); const st = S.settings || {};
  const goal = st.water_goal_ml || 3000, bottle = st.bottle_ml || 1180, glass = st.glass_ml || 250;
  const wt = waterOn(today); const n = Math.ceil(goal / bottle);
  const bottles = Array.from({ length: n }, (_, i) => {
    const cap = Math.min(bottle, goal - i * bottle); const f = Math.max(0, Math.min(1, (wt - i * bottle) / bottle));
    const h = Math.round(150 * f) ;
    return `<div class="btl"><svg width="70" height="150" viewBox="0 0 90 190" aria-hidden="true">
      <rect x="30" y="2" width="30" height="16" rx="5" fill="#2b2540"/><rect x="18" y="16" width="54" height="10" rx="4" fill="#463d66"/>
      <clipPath id="bc${i}"><path d="M14 30 H76 L68 182 Q67 188 61 188 H29 Q23 188 22 182 Z"/></clipPath>
      <path d="M14 30 H76 L68 182 Q67 188 61 188 H29 Q23 188 22 182 Z" style="fill:var(--accent-soft);stroke:var(--track)" stroke-width="2"/>
      <rect x="0" y="${188 - Math.round(158 * f)}" width="90" height="${Math.round(158 * f)}" fill="#3fa3e0" opacity=".85" clip-path="url(#bc${i})"/>
      <path d="M76 50 Q90 52 88 80 Q86 104 72 104" fill="none" stroke="#463d66" stroke-width="7" stroke-linecap="round"/></svg>
      <small>${cap < bottle ? litres(cap) + ' л' : 'пляшка ' + (i + 1)}</small></div>`;
  }).join('');
  const log = S.mj.water.filter((w) => w.day === today).slice().reverse().map((w) =>
    `<div class="mrow"><span class="f">+${w.ml} мл<small>${hm(new Date(w.created_at))}</small></span><button class="shx" data-a="mjwdel" data-id="${w.id}" aria-label="Видалити">✕</button></div>`).join('');
  const mc = checkinOf(today, 'morning'); const ck = S.sleepDraft || { start: mc?.sleep_start?.slice(0, 5) || '', end: mc?.sleep_end?.slice(0, 5) || '', q: mc?.sleep_quality ?? null };
  S.sleepDraft = ck;
  const sm = sleepMins({ sleep_start: ck.start, sleep_end: ck.end });
  return mjHead('Вода і сон', 'Сьогодні') + `
    <div class="panel">
      <div class="row" style="color:var(--ink)"><span style="font-size:26px;font-weight:800">${litres(wt)} <span style="font-size:15px;color:var(--muted)">з ${litres(goal)} л</span></span><span style="font-size:12px">${wt >= goal ? 'ціль виконано' : 'ще ' + litres(goal - wt) + ' л'}</span></div>
      <div class="btls">${bottles}</div>
      <div class="opts" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <button class="opt" data-a="mjw" data-v="${Math.round(bottle / 2)}">½ пляшки</button>
        <button class="opt on" data-a="mjw" data-v="${bottle}">Пляшка</button>
        <button class="opt" data-a="mjw" data-v="${glass}">Склянка</button></div>
      <p style="font-size:12px">Пляшка Stanley — ${litres(bottle)} л, склянка — ${glass} мл. Пий потроху протягом дня.</p>
      ${log}
    </div>
    <div class="panel"><h3>Сон минулої ночі</h3>
      <div class="opts"><label class="lbl">Заснула<input type="time" data-sin="start" value="${esc(ck.start)}"></label><label class="lbl">Прокинулась<input type="time" data-sin="end" value="${esc(ck.end)}"></label></div>
      <div class="seg">${['Погано', 'Нормально', 'Добре'].map((l, i) => `<button type="button" class="${ck.q === i ? 'on' : ''}" data-a="mjsq" data-v="${i}">${l}</button>`).join('')}</div>
      ${sm != null ? `<p style="font-size:13px">Тривалість: <b>${fmtMins(sm)}</b></p>` : ''}
      <button class="btn" data-a="mjsleep">Зберегти сон</button></div>`;
}

const MEASURES = [
  ['waist_cm', 'Талія', 'найвужче місце, приблизно на 2–3 см вище пупка'],
  ['belly_cm', 'Живіт', 'на рівні пупка'],
  ['hips_cm', 'Стегна (сідниці)', 'по найширшій частині сідниць, ноги разом'],
  ['chest_cm', 'Груди', 'під пахвами, по найвищій точці грудей'],
  ['thigh_cm', 'Стегно', 'найширше місце одного стегна, завжди тієї самої ноги'],
  ['arm_cm', 'Плече', 'посередині між плечем і ліктем, рука розслаблена']
];
const n1 = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
function mjWeight() {
  const st = S.settings || {}; const rows = S.mj.body.filter((b) => b.weight_kg != null);
  const start = Number(st.weight_start || rows[0]?.weight_kg || 0), goal = Number(st.weight_goal || 0);
  let chart = '';
  if (start) {
    const pts = [{ day: 'старт', v: start }, ...rows.map((r) => ({ day: r.day, v: Number(r.weight_kg) }))].slice(-12);
    const vals = pts.map((p) => p.v).concat(goal ? [goal] : []); const hi = Math.max(...vals) + 1, lo = Math.min(...vals) - 1;
    const X = (i) => 20 + i * (290 / Math.max(1, pts.length - 1)), Y = (v) => 10 + (hi - v) / (hi - lo) * 100;
    chart = `<svg viewBox="0 0 320 120" width="100%" role="img" aria-label="Графік ваги">
      ${goal ? `<line x1="10" x2="315" y1="${Y(goal)}" y2="${Y(goal)}" stroke="#9bd43f" stroke-width="2" stroke-dasharray="5 5"/><text x="312" y="${Y(goal) - 5}" font-size="10" text-anchor="end" fill="#4d7c0f">ціль ${goal}</text>` : ''}
      ${pts.length > 1 ? `<polyline fill="none" stroke="#6c5ce7" stroke-width="3" stroke-linejoin="round" points="${pts.map((p, i) => `${X(i)},${Y(p.v)}`).join(' ')}"/>` : ''}
      ${pts.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p.v)}" r="5" fill="#6c5ce7"/>`).join('')}</svg>`;
  }
  const cur = rows.length ? Number(rows[rows.length - 1].weight_kg) : start;
  const list = [...S.mj.body].reverse().slice(0, 10).map((b) => {
    const parts = [b.weight_kg != null ? n1(b.weight_kg) + ' кг' : null, ...MEASURES.filter(([f]) => b[f] != null).map(([f, l]) => `${l.split(' ')[0].toLowerCase()} ${n1(b[f])}`)].filter(Boolean);
    return `<div class="mrow"><span class="f"><b>${esc(fmtDay(b.day, { day: 'numeric', month: 'long' }))}</b><small>${esc(parts.join(' · '))}</small></span><button class="shx" data-a="mjbdel" data-id="${b.id}" aria-label="Видалити">✕</button></div>`;
  }).join('');
  // зміни обʼємів: перший замір → останній
  const mrows = MEASURES.map(([f, l]) => {
    const vals = S.mj.body.filter((b) => b[f] != null); if (!vals.length) return '';
    const a = Number(vals[0][f]), z = Number(vals[vals.length - 1][f]); const d = Math.round((z - a) * 10) / 10;
    return `<div class="row" style="color:var(--ink);font-weight:500"><span>${l}</span><span><b>${n1(z)} см</b>${vals.length > 1 ? ` <small style="color:${d <= 0 ? 'var(--ok-ink)' : '#b45309'}">${d <= 0 ? '−' : '+'}${n1(Math.abs(d))}</small>` : ''}</span></div>`;
  }).join('');
  return mjHead('Вага й обʼєми', 'Раз на тиждень, зранку') + `
    <div class="panel"><div class="row" style="color:var(--ink)"><span style="font-size:28px;font-weight:800">${cur ? String(cur).replace('.', ',') : '—'} <span style="font-size:15px;color:var(--muted)">кг</span></span>
      <span style="font-size:12px">${start && cur ? (cur <= start ? '−' : '+') + String(Math.abs(Math.round((start - cur) * 10) / 10)).replace('.', ',') + ' кг від старту' : ''}${goal && cur ? ' · до цілі ' + String(Math.max(0, Math.round((cur - goal) * 10) / 10)).replace('.', ',') : ''}</span></div>${chart}</div>
    <div class="panel"><h3>Новий запис</h3>
      <label class="lbl">Вага, кг<input type="number" step="0.1" inputmode="decimal" data-bin="weight_kg" placeholder="напр. 107,4"></label>
      <p style="font-size:12px">Зважуйся в той самий день тижня, зранку, після туалету — так цифри можна порівнювати.</p>
      <details class="meas"><summary>Обʼєми, см · раз на 2–4 тижні</summary>
        ${MEASURES.map(([f, l, hint]) => `<label class="lbl">${l}<small>${hint}</small><input type="number" step="0.5" inputmode="decimal" data-bin="${f}" placeholder="см"></label>`).join('')}
        <p style="font-size:12px">Міряй зранку, стоячи, розслаблено, на видиху. Сантиметр горизонтально, щільно, але не втискаючи.</p>
      </details>
      <button class="btn" data-a="mjbody">Зберегти за сьогодні</button></div>
    ${mrows ? `<div class="panel"><h3>Обʼєми · зміна від першого заміру</h3>${mrows}</div>` : ''}
    ${list ? `<div class="panel"><h3>Історія</h3>${list}</div>` : ''}
    <div class="panel"><h3>Старт і ціль</h3>
      <div class="opts"><label class="lbl">Стартова вага, кг<input type="number" step="0.1" inputmode="decimal" data-gin="start" value="${st.weight_start ?? ''}"></label><label class="lbl">Ціль, кг<input type="number" step="0.1" inputmode="decimal" data-gin="goal" value="${st.weight_goal ?? ''}"></label></div>
      <button class="btn ghost" data-a="mjgoal">Зберегти старт і ціль</button></div>`;
}

function mjActivity() {
  const plan = S.settings?.activity_plan || []; const today = todayStr();
  const rows = weekDays().map((d) => {
    const dow = parseYmd(d).getDay(); const p = plan.find((x) => x.dow === dow); const on = !!activityOn(d);
    return `<button class="arow ${d === today ? 'today' : ''}" data-a="mjact" data-day="${d}" ${d > today ? 'disabled' : ''}><span class="cb ${on ? 'on' : ''}">${on ? ICON_CHECK : ''}</span><b>${WD[(dow + 6) % 7]}</b><span>${esc(p?.title || '—')}</span></button>`;
  }).join('');
  return mjHead('Активність', 'Цей тиждень · за самопочуттям') + `
    <div class="panel" style="gap:0">${rows}</div>
    <div class="panel"><h3>Силове вдома · вт, пт</h3>${EXERCISES.map(([a, b]) => `<div class="row" style="color:var(--ink);font-weight:500"><span>${a}</span><b>${b}</b></div>`).join('')}
      <p style="font-size:12px">Болить — не роби через силу, зменш амплітуду.</p></div>`;
}

function openCheckin(slot) {
  const today = todayStr(); const c = checkinOf(today, slot);
  S.ck = { slot, symptoms: new Set(c?.symptoms || []), severity: c?.severity ?? null, appetite: c?.appetite ?? null, energy: c?.energy ?? null, protein: c?.protein ?? null,
    sleep_start: c?.sleep_start?.slice(0, 5) || '', sleep_end: c?.sleep_end?.slice(0, 5) || '', sleep_quality: c?.sleep_quality ?? null, note: c?.note || '' };
  S.view = 'mj'; S.mjSub = 'checkin'; render(); window.scrollTo(0, 0);
}
function mjCheckin() {
  const today = todayStr(); const c = S.ck; const t = slotTimes();
  const segq = (field, labels) => `<div class="seg">${labels.map((l, i) => `<button type="button" class="${c[field] === i ? 'on' : ''}" data-a="mjcf" data-f="${field}" data-v="${i}">${l}</button>`).join('')}</div>`;
  const tabs = SLOTS.map((s, i) => { const d = !!checkinOf(today, s.id); return `<button class="slot ${c.slot === s.id ? 'on' : ''} ${d ? 'done' : ''}" data-a="mjcheck" data-v="${s.id}"><b>${s.name}</b><small>${t[i]}${d ? ' · ✓' : ''}</small></button>`; }).join('');
  const none = c.symptoms.size === 0;
  const danger = c.severity === 3 || ((c.symptoms.has('Біль у животі') || c.symptoms.has('Блювання')) && c.severity >= 2);
  return mjHead('Самопочуття', fmtDay(today, { weekday: 'long', day: 'numeric', month: 'long' })) + `
    <div class="slots">${tabs}</div>
    ${c.slot === 'morning' ? `<div class="panel"><h3>Сон</h3><div class="opts"><label class="lbl">Заснула<input type="time" data-cin="sleep_start" value="${esc(c.sleep_start)}"></label><label class="lbl">Прокинулась<input type="time" data-cin="sleep_end" value="${esc(c.sleep_end)}"></label></div>${segq('sleep_quality', ['Погано', 'Нормально', 'Добре'])}</div>` : ''}
    <div class="panel"><h3>Що зараз відчуваєш?</h3><div class="chips">${SYMPTOMS.map((s) => `<button type="button" class="opt ${c.symptoms.has(s) ? 'on' : ''}" data-a="mjsym" data-v="${esc(s)}">${esc(s)}</button>`).join('')}<button type="button" class="opt ${none ? 'on' : ''}" data-a="mjsym" data-v="">Нічого</button></div></div>
    <div class="panel"><h3>Наскільки сильно?</h3>${segq('severity', ['Немає', 'Легко', 'Помірно', 'Сильно'])}</div>
    ${danger ? '<div class="panel warn"><b>Будь уважна</b><p>Сильний постійний біль у животі (особливо з віддачею в спину), багаторазове блювання, неможливість пити, сильне запаморочення або дуже мало сечі — звернись до лікаря терміново.</p></div>' : ''}
    <div class="panel"><h3>Апетит</h3>${segq('appetite', ['Звичайний', 'Знизився', 'Майже нема'])}</div>
    <div class="panel"><h3>Енергія</h3>${segq('energy', ['Мало', 'Норм', 'Багато'])}</div>
    ${c.slot === 'evening' ? `<div class="panel"><h3>Білок за день</h3>${segq('protein', ['Мало', 'Норм', 'Добре'])}</div>` : ''}
    <div class="panel"><label class="lbl">Коментар (не обовʼязково)<textarea rows="2" data-cin="note">${esc(c.note)}</textarea></label>
      <button class="btn" data-a="mjcsave">Зберегти · ${SLOTS.find((s) => s.id === c.slot).name.toLowerCase()}</button></div>
    <div class="panel"><div class="nrow"><span>Нагадування<small>${t.join(', ')} — на телефон і в Telegram</small></span><button class="sw" role="switch" aria-checked="${!!S.settings?.checkin_reminders}" data-a="mjrem" aria-label="Нагадування про самопочуття"></button></div></div>`;
}

function mjView() {
  if (!S.mj) return '<div class="boot">Завантаження…</div>';
  if (S.mjSub === 'water') return mjWater();
  if (S.mjSub === 'weight') return mjWeight();
  if (S.mjSub === 'activity') return mjActivity();
  if (S.mjSub === 'checkin' && S.ck) return mjCheckin();
  return mjOverview();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-a]'); if (!el || !el.dataset.a.startsWith('mj')) return;
  const a = el.dataset.a; const today = todayStr();
  if (a === 'mjback') { S.mjSub = null; S.sleepDraft = null; render(); window.scrollTo(0, 0); }
  else if (a === 'mjsub') { S.mjSub = el.dataset.v; S.sleepDraft = null; render(); window.scrollTo(0, 0); }
  else if (a === 'mjcheck') openCheckin(el.dataset.v);
  else if (a === 'mjw') {
    const ml = Number(el.dataset.v);
    const { data, error } = await sb.from('water_logs').insert({ day: today, ml }).select().single();
    if (error) return toast('Не вдалося зберегти');
    S.mj.water.push(data); render(); toast(`+${ml} мл`, async () => { S.toast = null; renderToast(); await sb.from('water_logs').delete().eq('id', data.id); S.mj.water = S.mj.water.filter((w) => w.id !== data.id); render(); });
  }
  else if (a === 'mjwdel') { const id = el.dataset.id; await sb.from('water_logs').delete().eq('id', id); S.mj.water = S.mj.water.filter((w) => w.id !== id); render(); }
  else if (a === 'mjsq') { S.sleepDraft.q = Number(el.dataset.v); render(); }
  else if (a === 'mjsleep') {
    const d = S.sleepDraft; const prev = checkinOf(today, 'morning');
    const row = { day: today, slot: 'morning', sleep_start: d.start || null, sleep_end: d.end || null, sleep_quality: d.q, symptoms: prev?.symptoms || [] };
    const { data, error } = await sb.from('checkins').upsert(row, { onConflict: 'user_id,day,slot' }).select().single();
    if (error) return toast('Не вдалося зберегти: ' + error.message);
    S.mj.checkins = S.mj.checkins.filter((c) => !(c.day === today && c.slot === 'morning')).concat(data); S.sleepDraft = null; render(); toast('Сон збережено');
  }
  else if (a === 'mjbody') {
    const val = (f) => parseFloat(String(document.querySelector(`[data-bin="${f}"]`)?.value || '').replace(',', '.'));
    const prev = S.mj.body.find((b) => b.day === today) || {};
    const row = { day: today }; let any = false;
    const w = val('weight_kg'); if (w > 30 && w < 300) { row.weight_kg = w; any = true; } else row.weight_kg = prev.weight_kg ?? null;
    for (const [f] of MEASURES) { const v = val(f); if (v > 10 && v < 250) { row[f] = v; any = true; } else row[f] = prev[f] ?? null; }
    if (!any) return toast('Введи вагу або хоча б один обʼєм');
    const { data, error } = await sb.from('body_logs').upsert(row, { onConflict: 'user_id,day' }).select().single();
    if (error) return toast('Не вдалося зберегти: ' + error.message);
    S.mj.body = S.mj.body.filter((b) => b.day !== today).concat(data).sort((x, y) => x.day < y.day ? -1 : 1); render(); toast('Збережено');
  }
  else if (a === 'mjgoal') {
    const num = (f) => { const v = parseFloat(String(document.querySelector(`[data-gin="${f}"]`)?.value || '').replace(',', '.')); return v > 30 && v < 300 ? Math.round(v * 10) / 10 : null; };
    const ws = num('start'), wg = num('goal');
    if (ws == null && wg == null) return toast('Введи вагу від 30 до 300 кг');
    await updateSettings({ weight_start: ws, weight_goal: wg }); toast('Старт і ціль збережено');
  }
  else if (a === 'mjbdel') { const id = el.dataset.id; await sb.from('body_logs').delete().eq('id', id); S.mj.body = S.mj.body.filter((b) => b.id !== id); render(); }
  else if (a === 'mjact') {
    const d = el.dataset.day; const cur = S.mj.activity.find((x) => x.day === d);
    if (cur && cur.done) { await sb.from('activity_logs').delete().eq('id', cur.id); S.mj.activity = S.mj.activity.filter((x) => x.id !== cur.id); }
    else { const { data, error } = await sb.from('activity_logs').upsert({ day: d, done: true }, { onConflict: 'user_id,day' }).select().single(); if (error) return toast('Не вдалося зберегти'); S.mj.activity = S.mj.activity.filter((x) => x.day !== d).concat(data); }
    render();
  }
  else if (a === 'mjsym') { const v = el.dataset.v; if (!v) S.ck.symptoms.clear(); else if (S.ck.symptoms.has(v)) S.ck.symptoms.delete(v); else S.ck.symptoms.add(v); render(); }
  else if (a === 'mjcf') { const f = el.dataset.f; const v = Number(el.dataset.v); S.ck[f] = S.ck[f] === v ? null : v; render(); }
  else if (a === 'mjcsave') {
    const c = S.ck;
    const row = { day: today, slot: c.slot, symptoms: [...c.symptoms], severity: c.severity, appetite: c.appetite, energy: c.energy, protein: c.slot === 'evening' ? c.protein : null,
      sleep_start: c.slot === 'morning' ? c.sleep_start || null : null, sleep_end: c.slot === 'morning' ? c.sleep_end || null : null, sleep_quality: c.slot === 'morning' ? c.sleep_quality : null, note: c.note.trim() || null };
    const { data, error } = await sb.from('checkins').upsert(row, { onConflict: 'user_id,day,slot' }).select().single();
    if (error) return toast('Не вдалося зберегти: ' + error.message);
    S.mj.checkins = S.mj.checkins.filter((x) => !(x.day === today && x.slot === c.slot)).concat(data);
    S.mjSub = null; S.ck = null; render(); window.scrollTo(0, 0); toast('Самопочуття збережено');
  }
  else if (a === 'mjrem') updateSettings({ checkin_reminders: !S.settings.checkin_reminders });
});
// дата старту: перемалювати редактор лише після вибору (щоб не закривати календар iOS)
document.addEventListener('change', (e) => {
  if (e.target.dataset?.ein !== 'start_date' || !S.ed) return;
  S.ed.start_date = e.target.value;
  if (S.ed.start_date && S.ed.kind === 'weekly' && S.ed.weekdays.length <= 1) S.ed.weekdays = [parseYmd(S.ed.start_date).getDay()];
  renderEditor();
});
document.addEventListener('input', (e) => {
  const d = e.target.dataset || {};
  if (d.cin && S.ck) S.ck[d.cin] = e.target.value;
  if (d.sin && S.sleepDraft) S.sleepDraft[d.sin] = e.target.value;
});

// ---------- med editor ----------
const COLORS = ['#e6a700', '#3fa3e0', '#e66aa8', '#6c5ce7', '#2bb39a', '#f0784a', '#8a7f9e'];
function openEditor(id) {
  const m = id ? S.meds.find((x) => x.id === id) : null;
  S.ed = m ? {
    id: m.id, name: m.name, inj: !!m.track_sites, dose_label: m.dose_label, doses: (m.dose_options || []).join(', '),
    kind: m.kind, weekdays: [...wdays(m)], interval_days: m.interval_days || 2, start_date: m.start_date || '',
    plan_time: planHM(m), window_label: m.window_label || '', note: m.note || '', color: m.color,
    remind: m.remind_before_min, follow: m.followup_after_min, late: m.late_window_days || 0, active: m.active, confirmDel: false, err: ''
  } : { late: 0, id: null, name: '', inj: false, dose_label: '', doses: '', kind: 'daily', weekdays: [], interval_days: 2, start_date: todayStr(),
    plan_time: '09:00', window_label: '', note: '', color: COLORS[S.meds.length % COLORS.length], remind: 5, follow: 15, active: true, confirmDel: false, err: '' };
  renderEditor();
}
function renderEditor() {
  const e = S.ed; const root = $('#editor-root');
  if (!e) { root.innerHTML = ''; return; }
  const seg = (field, opts) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" class="${e[field] === v ? 'on' : ''}" data-a="edset" data-f="${field}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const sel = (field, vals, fmt) => `<select data-ein="${field}">${vals.map((v) => `<option value="${v}" ${Number(e[field]) === v ? 'selected' : ''}>${fmt(v)}</option>`).join('')}</select>`;
  const sched = e.kind === 'weekly'
    ? `<div class="days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" class="opt ${e.weekdays.includes(d) ? 'on' : ''}" data-a="edday" data-v="${d}">${WD_SHORT[d]}</button>`).join('')}</div>`
    : e.kind === 'interval'
      ? `<div class="row">Кожні<input type="number" min="2" max="365" inputmode="numeric" data-ein="interval_days" value="${e.interval_days}" style="width:90px">днів</div>` : '';
  root.innerHTML = `<div class="ov" role="dialog" aria-modal="true" aria-label="Ліки"><button class="bg" data-a="edclose" aria-label="Закрити"></button>
    <div class="sh"><span class="grab"></span><div class="shh"><div class="ttl">${e.id ? 'Змінити ліки' : 'Нові ліки'}</div><button class="shx" data-a="edclose" aria-label="Закрити"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <label class="lbl">Назва<input type="text" data-ein="name" value="${esc(e.name)}" placeholder="Напр. Вітамін D"></label>
    <div class="lbl">Тип${seg('inj', [[false, 'Таблетки'], [true, 'Укол']])}</div>
    <label class="lbl">Дозування<input type="text" data-ein="dose_label" value="${esc(e.dose_label)}" placeholder="Напр. 2 × 50 мг або 1 таблетка"></label>
    ${e.inj ? '' : `<label class="lbl">Варіанти кількості (необовʼязково)<input type="text" inputmode="numeric" data-ein="doses" value="${esc(e.doses)}" placeholder="Напр. 2, 3 — зʼявляться кнопки вибору"></label>`}
    <div class="lbl">Періодичність${seg('kind', [['daily', 'Щодня'], ['weekly', 'Дні тижня'], ['interval', 'Кожні N днів']])}${sched}</div>
    <label class="row">Дата старту<input type="date" data-ein="start_date" value="${esc(e.start_date)}"></label>
    <p style="font-size:12px;margin-top:-6px" id="ed-since">${e.start_date ? esc(sinceLabel(e.start_date)) + (e.kind === 'weekly' && e.weekdays.length === 1 ? ' · день тижня підлаштовується під дату старту' : '') : 'Необовʼязково. Якщо вказати — до цієї дати ліки не плануються, а тут видно, скільки вже приймаєш.'}</p>
    <label class="row">Час прийому<input type="time" data-ein="plan_time" value="${esc(e.plan_time)}"></label>
    <label class="lbl">Проміжок (необовʼязково)<input type="text" data-ein="window_label" value="${esc(e.window_label)}" placeholder="Напр. 9:00–10:00"></label>
    <label class="lbl">Примітка<input type="text" data-ein="note" value="${esc(e.note)}" placeholder="Напр. після їжі / за 2 год до їжі"></label>
    <div class="lbl">Колір<div class="colors">${COLORS.map((c) => `<button type="button" class="clr ${e.color === c ? 'on' : ''}" style="background:${c}" data-a="edcolor" data-v="${c}" aria-label="Колір"></button>`).join('')}</div></div>
    <label class="row">Нагадати за${sel('remind', [0, 5, 10, 15, 30, 60], (v) => v ? v + ' хв' : 'у час прийому')}</label>
    ${e.kind !== 'daily' ? `<label class="row">Пропущену дозу можна зробити${sel('late', [0, 1, 2, 3, 4, 5, 6], (v) => v ? 'до ' + v + ' дн. пізніше' : 'не можна')}</label>` : ''}
    <label class="row">Повтор, якщо не відмічено${sel('follow', [0, 10, 15, 30, 60], (v) => v ? 'через ' + v + ' хв' : 'не повторювати')}</label>
    ${e.id ? `<div class="nrow"><span>Активні<small>Вимкни, щоб поставити на паузу без втрати історії</small></span><button type="button" class="sw" role="switch" aria-checked="${e.active}" data-a="edactive" aria-label="Активні"></button></div>` : ''}
    ${e.err ? `<div class="err">${esc(e.err)}</div>` : ''}
    <button class="btn" data-a="edsave">Зберегти</button>
    ${e.id ? `<button class="btn link" data-a="eddel" style="color:#b42318">${e.confirmDel ? 'Точно видалити? Уся історія цих ліків теж зникне — натисни ще раз' : 'Видалити ліки'}</button>` : ''}
    </div></div>`;
}
async function saveEditor() {
  const e = S.ed;
  if (!e.name.trim()) { e.err = 'Вкажи назву'; return renderEditor(); }
  if (!e.dose_label.trim()) { e.err = 'Вкажи дозування'; return renderEditor(); }
  if (!/^\d{2}:\d{2}$/.test(e.plan_time)) { e.err = 'Вкажи час прийому'; return renderEditor(); }
  if (e.kind === 'weekly' && !e.weekdays.length) { e.err = 'Вибери хоча б один день тижня'; return renderEditor(); }
  const iv = Number(e.interval_days);
  if (e.kind === 'interval' && !(iv >= 2 && iv <= 365)) { e.err = 'Інтервал — від 2 до 365 днів'; return renderEditor(); }
  if (e.kind === 'interval' && !e.start_date) e.start_date = todayStr();
  const doses = e.inj ? [] : e.doses.split(/[,;\s]+/).map(Number).filter((n) => n > 0 && n < 100);
  const row = {
    name: e.name.trim(), dose_label: e.dose_label.trim(), dose_options: doses.length ? doses : null, track_sites: e.inj,
    kind: e.kind, weekdays: e.kind === 'weekly' ? e.weekdays : null, weekday: e.kind === 'weekly' ? e.weekdays[0] : null,
    interval_days: e.kind === 'interval' ? iv : null, start_date: e.start_date || null,
    plan_time: e.plan_time, window_label: e.window_label.trim() || null, note: e.note.trim() || null, color: e.color,
    remind_before_min: Number(e.remind), followup_after_min: Number(e.follow), late_window_days: e.kind === 'daily' ? 0 : Number(e.late || 0), active: e.active
  };
  let res;
  if (e.id) res = await sb.from('meds').update(row).eq('id', e.id).select().single();
  else res = await sb.from('meds').insert({ ...row, sort: Math.max(0, ...S.meds.map((m) => m.sort || 0)) + 1 }).select().single();
  if (res.error) { e.err = 'Не вдалося зберегти: ' + res.error.message; return renderEditor(); }
  const i = S.meds.findIndex((m) => m.id === res.data.id);
  if (i >= 0) S.meds[i] = res.data; else S.meds.push(res.data);
  S.ed = null; renderEditor(); render(); toast(`${row.name} — збережено`);
}
async function deleteMed() {
  const e = S.ed;
  if (!e.confirmDel) { e.confirmDel = true; return renderEditor(); }
  const { error } = await sb.from('meds').delete().eq('id', e.id);
  if (error) { e.err = 'Не вдалося видалити'; return renderEditor(); }
  S.meds = S.meds.filter((m) => m.id !== e.id);
  for (const key of [...S.intakes.keys()]) if (key.startsWith(e.id + '|')) S.intakes.delete(key);
  S.ed = null; renderEditor(); render(); toast('Видалено');
}

// ---------- swipe down to close sheets ----------
let drag = null;
document.addEventListener('touchstart', (e) => {
  const sh = e.target.closest('.sh'); if (!sh) return;
  if (e.target.closest('input,textarea,select')) return;
  if (sh.scrollTop > 0 && !e.target.closest('.grab,.shh')) return;
  drag = { sh, ov: sh.closest('.ov'), y: e.touches[0].clientY, dy: 0 };
  sh.style.transition = 'none'; if (drag.ov) drag.ov.style.transition = 'none';
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!drag) return;
  const dy = e.touches[0].clientY - drag.y;
  if (dy <= 0 && drag.dy === 0) { drag = null; return; } // це прокрутка вгору — не заважаємо
  drag.dy = Math.max(0, dy);
  drag.sh.style.transform = `translateY(${drag.dy}px)`;
  if (drag.ov) drag.ov.style.background = `rgba(20,18,30,${(0.45 * Math.max(0, 1 - drag.dy / drag.sh.offsetHeight)).toFixed(3)})`;
  if (e.cancelable) e.preventDefault();
}, { passive: false });
document.addEventListener('touchend', () => {
  if (!drag) return;
  const { sh, ov, dy } = drag; drag = null;
  sh.style.transition = 'transform .2s ease';
  if (ov) ov.style.transition = 'background .2s ease';
  if (dy > 110) {
    sh.style.transform = 'translateY(100%)';
    if (ov) ov.style.background = 'rgba(20,18,30,0)';
    setTimeout(() => ov?.querySelector('.bg')?.click(), 190);
  } else { sh.style.transform = ''; if (ov) ov.style.background = ''; }
});

// ---------- свайп «назад» (як в iPhone: від лівого краю вправо) ----------
function canGoBack() { return (S.view === 'mj' && S.mjSub) || (S.view === 'today' && S.daySel); }
function goBack() {
  if (S.view === 'mj' && S.mjSub) { S.mjSub = null; S.ck = null; S.sleepDraft = null; }
  else if (S.view === 'today' && S.daySel) S.daySel = null;
  render(); window.scrollTo(0, 0);
}
let sw = null;
document.addEventListener('touchstart', (e) => {
  if (S.sheet || S.ed || S.quick || !canGoBack()) return;
  if (e.target.closest('input,textarea,select,.sh')) return;
  const t = e.touches[0]; sw = { x: t.clientX, y: t.clientY, dx: 0, on: false, edge: t.clientX < 40 };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!sw) return;
  const t = e.touches[0]; const dx = t.clientX - sw.x, dy = t.clientY - sw.y;
  if (!sw.on) {
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; } // вертикальна прокрутка
    if (dx > 12 && dx > Math.abs(dy) * 1.5) sw.on = true; else return;
  }
  sw.dx = Math.max(0, dx);
  const main = document.querySelector('main.wrap');
  if (main) { main.style.transition = 'none'; main.style.transform = `translateX(${sw.dx}px)`; main.style.opacity = String(1 - Math.min(0.4, sw.dx / 800)); }
  if (e.cancelable) e.preventDefault();
}, { passive: false });
document.addEventListener('touchend', () => {
  if (!sw) return; const { dx, on, edge } = sw; sw = null; if (!on) return;
  const main = document.querySelector('main.wrap'); if (!main) return;
  main.style.transition = 'transform .2s ease, opacity .2s ease';
  if (dx > (edge ? 60 : 110)) { main.style.transform = 'translateX(100%)'; main.style.opacity = '0'; setTimeout(goBack, 180); }
  else { main.style.transform = ''; main.style.opacity = ''; }
});

// ---------- render ----------
function render() {
  if (!S.user) return;
  const v = S.view === 'history' ? historyView() : S.view === 'meds' ? medsView() : S.view === 'mj' ? mjView() : todayView();
  $('#app').innerHTML = `<main class="wrap">${v}</main>${navHtml()}`;
  if (S.sheet) renderSheet();
  if (S.quick) renderQuick();
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a; const sh = S.sheet;
  if (a === 'nav') { S.view = el.dataset.v; S.daySel = null; S.mjSub = null; S.ck = null; if (S.view === 'history') { S.sel = null; S.month = null; } render(); window.scrollTo(0, 0); }
  else if (a === 'open') openSheet(el.dataset.id, el.dataset.day, el.dataset.late === '1');
  else if (a === 'lateskip') { const m = S.meds.find((x) => x.id === el.dataset.id); await saveIntake(m, el.dataset.day, { status: 'skipped', taken_at: null, dose: null, site: null, note: 'дозу пропущено' }); toast(`${m.name} — пропуск записано`); }
  else if (a === 'quick') {
    const m = S.meds.find((x) => x.id === el.dataset.id); const day = todayStr(); const now = new Date();
    await saveIntake(m, day, { status: 'taken', taken_at: now.toISOString(), dose: m.dose_options?.[0] ?? null, note: null, site: null });
    toast(`${m.name} — о ${hm(now)}${m.dose_options?.length ? ` · ${m.dose_options[0]} таб.` : ''}`, async () => { S.toast = null; renderToast(); await deleteIntake(m, day); });
  }
  else if (a === 'undo') { const u = S.toast?.undo; if (u) u(); }
  else if (a === 'pick') { S.sel = el.dataset.day; render(); }
  else if (a === 'mprev' || a === 'mnext') { const m = S.month || new Date(); S.month = new Date(m.getFullYear(), m.getMonth() + (a === 'mprev' ? -1 : 1), 1); S.sel = null; render(); }
  else if (a === 'logout') { await sb.auth.signOut(); location.reload(); }
  else if (a === 'qclose') { S.quick = null; renderQuick(); }
  else if (a === 'qmore') { const { m, day } = S.quick; S.quick = null; renderQuick(); openSheet(m.id, day); }
  else if (a === 'qsite') { S.quick.site = el.dataset.v; renderQuick(); }
  else if (a === 'qtake') {
    const { m, day } = S.quick; const now = new Date(); const dose = el.dataset.v ? Number(el.dataset.v) : null;
    await saveIntake(m, day, { status: 'taken', taken_at: now.toISOString(), dose, site: m.track_sites ? S.quick.site : null, note: null });
    let msg = `Відмічено о ${hm(now)}` + (dose ? ` · ${dose} таб.` : '') + (m.track_sites ? ` · ${S.quick.site}` : '');
    if (/до їжі/.test(m.note || '')) msg += `. Їсти можна з ${addMin(hm(now), 120)}`;
    quickDone(msg);
  }
  else if (a === 'qskip') { const { m, day } = S.quick; await saveIntake(m, day, { status: 'skipped', taken_at: null, dose: null, site: null, note: null }); quickDone('Записала як пропуск'); }
  else if (a === 'qsnooze') {
    const { m, day } = S.quick; const due = new Date(Date.now() + 15 * 60000);
    const { error } = await sb.from('snoozes').insert({ med_id: m.id, day, due_at: due.toISOString() });
    if (error) toast('Не вдалося: ' + error.message); else quickDone(`Нагадаю о ${hm(due)}`);
  }
  else if (a === 'theme') { try { localStorage.setItem(THEME_KEY, el.dataset.v); } catch (_) {} applyTheme(); render(); }
  else if (a === 'wpick') { const d = el.dataset.day; S.daySel = d && d !== todayStr() ? d : null; render(); }
  else if (a === 'edopen') openEditor(el.dataset.id);
  else if (a === 'ednew') openEditor(null);
  else if (a === 'edclose') { S.ed = null; renderEditor(); }
  else if (a === 'edset') { const f = el.dataset.f; let v = el.dataset.v; if (f === 'inj') v = v === 'true'; S.ed[f] = v; if (f === 'kind' && v === 'weekly' && !S.ed.weekdays.length) S.ed.weekdays = [new Date().getDay()]; S.ed.err = ''; renderEditor(); }
  else if (a === 'edday') { const d = Number(el.dataset.v); const w = S.ed.weekdays; S.ed.weekdays = w.includes(d) ? w.filter((x) => x !== d) : [...w, d]; renderEditor(); }
  else if (a === 'edcolor') { S.ed.color = el.dataset.v; renderEditor(); }
  else if (a === 'edactive') { S.ed.active = !S.ed.active; renderEditor(); }
  else if (a === 'edsave') saveEditor();
  else if (a === 'eddel') deleteMed();
  else if (a === 'pushon') enablePush();
  else if (a === 'pushoff') disablePush();
  else if (a === 'pushtoggle') updateSettings({ notify_push: !S.settings.notify_push });
  else if (a === 'tgtoggle') updateSettings({ notify_telegram: !S.settings.notify_telegram });
  else if (a === 'lmode') { loginMode = el.dataset.v; $('#app').innerHTML = loginView(); }
  else if (!sh) return;
  else if (a === 'sclose') { S.sheet = null; renderSheet(); }
  else if (a === 'sedit') { sh.edit = true; renderSheet(); }
  else if (a === 'sdel') { const { m, day } = sh; S.sheet = null; renderSheet(); await deleteIntake(m, day); toast(`${m.name}: відмітку скасовано`); }
  else if (a === 'sdose') { sh.dose = Number(el.dataset.v); renderSheet(); }
  else if (a === 'ssite') { sh.site = el.dataset.v; renderSheet(); }
  else if (a === 'smode') { sh.mode = el.dataset.v; if (sh.mode === 'custom' && !sh.time) sh.time = hm(new Date()); renderSheet(); }
  else if (a === 'ssave') {
    const { m, day } = sh; const t = sh.mode === 'now' ? hm(new Date()) : (sh.time || planHM(m));
    const actual = sh.late ? todayStr() : day;
    S.sheet = null; renderSheet();
    await saveIntake(m, day, { status: 'taken', taken_at: sh.late && sh.mode === 'now' ? new Date().toISOString() : takenAtFor(actual, t), dose: m.dose_options?.length ? sh.dose : null, site: m.track_sites ? sh.site : null, note: sh.note.trim() || null });
    toast(`${m.name} — відмічено о ${t}`);
  }
  else if (a === 'sskip') {
    const { m, day } = sh; S.sheet = null; renderSheet();
    await saveIntake(m, day, { status: 'skipped', taken_at: null, dose: null, site: null, note: sh.note.trim() || null });
    toast(`${m.name} — пропуск записано`);
  }
});

document.addEventListener('input', (e) => {
  const ef = e.target.dataset?.ein; if (ef && S.ed) {
    S.ed[ef] = e.target.value;
    return;
  }
  const f = e.target.dataset?.in; if (!f || !S.sheet) return;
  S.sheet[f] = e.target.value;
  if (f === 'time') { const b = document.querySelector('[data-a="ssave"]'); if (b) b.textContent = `${S.sheet.m.track_sites ? 'Відмітити укол' : 'Прийняла'} · ${e.target.value}`; }
});

document.addEventListener('submit', async (e) => {
  if (e.target.dataset.form !== 'login') return;
  e.preventDefault();
  const f = e.target; const email = f.email.value.trim(); const password = f.password.value;
  const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Зачекай…';
  if (loginMode === 'up') {
    if (password !== f.password2.value) { $('#app').innerHTML = loginView('Паролі не збігаються'); return; }
    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) { $('#app').innerHTML = loginView(/registered/i.test(error.message) ? 'Такий акаунт уже є — перейди на «Вхід».' : 'Не вдалося: ' + error.message); return; }
    if (!data.session) { loginMode = 'in'; $('#app').innerHTML = loginView('', 'Акаунт створено. Підтверди пошту за посиланням у листі (сторінка після нього може не відкритися — це нормально), потім увійди тут.'); }
    return;
  }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) $('#app').innerHTML = loginView(/confirm/i.test(error.message) ? 'Пошту ще не підтверджено — відкрий лист від Supabase.' : 'Неправильний email або пароль.');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.ed) { S.ed = null; renderEditor(); } else if (S.sheet) { S.sheet = null; renderSheet(); } else if (S.quick) { S.quick = null; renderQuick(); }
});
async function takePending() {
  try {
    const c = await caches.open('moi-liky-pending'); const r = await c.match('pending-quick');
    if (!r) return null; const url = await r.text(); await c.delete('pending-quick'); return url;
  } catch (_) { return null; }
}
async function checkPendingQuick() {
  if (!S.user) return;
  const url = await takePending(); if (!url) return;
  lastLoad = 0; await refresh(); openQuickFromUrl(url);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data?.type === 'open-quick') checkPendingQuick();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkPendingQuick(); });

// refresh when returning to the app (e.g. after answering in Telegram)
let lastLoad = 0;
async function refresh() {
  if (!S.user || Date.now() - lastLoad < 3000) return;
  lastLoad = Date.now();
  try { await loadAll(); render(); } catch (_) { /* offline */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
setInterval(() => { if (document.visibilityState === 'visible' && !S.sheet) render(); }, 60000);

// ---------- boot ----------
async function boot(session) {
  S.user = session?.user || null;
  if (!S.user) { $('#app').innerHTML = loginView(); return; }
  try { await ensureSeed(); await Promise.all([loadAll(), checkPush()]); lastLoad = Date.now(); render(); if (new URL(location.href).searchParams.get('q') || new URL(location.href).searchParams.get('c')) { await takePending(); openQuickFromUrl(); } else checkPendingQuick(); }
  catch (err) { $('#app').innerHTML = `<div class="login"><h1>Ой</h1><p>Не вдалося завантажити дані. Перевір інтернет і онови сторінку.</p><p class="err">${esc(err.message || err)}</p></div>`; }
}

let booted = false;
sb.auth.onAuthStateChange((ev, session) => {
  if (ev === 'SIGNED_IN' && !S.user) boot(session);
  else if (ev === 'SIGNED_OUT') { S.user = null; $('#app').innerHTML = loginView(); }
  else if (ev === 'INITIAL_SESSION' && !booted) { booted = true; boot(session); }
});

const APP_VERSION = 21;
// ---- тема: light / dark / auto ----
const THEME_KEY = 'moi-liky-theme';
const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (_) { return 'light'; } };
function applyTheme() {
  const t = getTheme(); const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#15141c' : '#f4f2fb');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
applyTheme();
// заборона зуму щипком і подвійним тапом (iOS ігнорує user-scalable=no у деяких режимах)
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  // коли встановилась нова версія — один раз перезавантажити сторінку
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || S.sheet || S.ed || S.quick) return; reloaded = true; location.reload();
  });
}
