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
      <circle cx="42" cy="42" r="34" fill="none" stroke="#e3ddf6" stroke-width="10"/>
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
    return `<div class="wd ${s === today ? 'today' : ''}"><span class="l">${l}</span><span class="n">${x.getDate()}</span><span class="dot" style="background:${dot}"></span></div>`;
  }).join('') + `</div>`;
}

function medCardHtml(m) {
  const today = todayStr(); const r = S.intakes.get(k(m.id, today));
  const taken = r && r.status === 'taken'; const skipped = r && r.status === 'skipped';
  let sub = `${m.dose_label} · ${m.window_label || planHM(m)}${m.note ? ' · ' + m.note : ''}`;
  let hint = '', hintOk = false;
  if (taken) {
    sub = (m.dose_options?.length && r.dose ? `${r.dose} таблетки` : m.dose_label) + (r.note ? ' · ' + r.note : '');
    if (/до їжі/.test(m.note || '')) { hint = 'Їсти можна з ' + addMin(timeOf(r), 120); hintOk = true; }
  } else if (skipped) {
    sub = 'Пропущено' + (r.note ? ' · ' + r.note : '');
  } else if (/після їжі/.test(m.note || '')) {
    const pre = activeMeds().find((x) => /до їжі/.test(x.note || ''));
    const pr = pre && S.intakes.get(k(pre.id, today));
    hint = pr && pr.status === 'taken' ? `Спершу поїсти (можна з ${addMin(timeOf(pr), 120)})` : 'Спершу поїсти';
  }
  const right = taken ? `<span class="chip ok">${ICON_CHECK}${timeOf(r)}</span>`
    : skipped ? `<span class="chip skip">Пропуск</span>`
    : `<button class="btn-quick" data-a="quick" data-id="${m.id}" aria-label="Відмітити ${esc(m.name)} зараз">Прийняла</button>`;
  return `<div class="card ${taken ? 'taken' : skipped ? 'skipped' : ''}">
    <button class="main" data-a="open" data-id="${m.id}" data-day="${today}" aria-label="Деталі: ${esc(m.name)}">
      <span class="ico" style="background:${tint(m.color)}">${ICON_PILL(m.color)}</span>
      <span class="txt"><span class="nm">${esc(m.name)}</span><span class="sb">${esc(sub)}</span>${hint ? `<span class="hint ${hintOk ? 'ok' : ''}">${esc(hint)}</span>` : ''}</span>
    </button>${right}</div>`;
}

function lastIntake(m) {
  let best = null; for (const r of S.intakes.values()) if (r.med_id === m.id && r.status === 'taken' && (!best || r.day > best.day)) best = r; return best;
}

function injHtml(m) {
  const today = todayStr(); const r = S.intakes.get(k(m.id, today));
  const done = r && r.status === 'taken';
  let sub, site;
  if (done) { sub = `Зроблено сьогодні о ${timeOf(r)}`; site = r.site || ''; }
  else if (r) { sub = 'Сьогодні — пропуск'; site = ''; }
  else { sub = `Сьогодні, ${planHM(m)} · ${m.dose_label}`; site = 'Місце: ' + suggestSite(m).toLowerCase(); }
  return `<div class="inj"><span class="ico">${ICON_SYR('#d8cffc')}</span>
    <span class="txt" style="flex:1"><span class="nm">${esc(m.name)}</span><span class="sb">${esc(sub)}</span>${site ? `<span class="site">${esc(site)}</span>` : ''}</span>
    <button class="act ${r ? 'done' : ''}" data-a="open" data-id="${m.id}" data-day="${today}">${r ? 'Деталі' : 'Відмітити'}</button></div>`;
}

function todayView() {
  const ms = dayMeds(todayStr());
  const pills = ms.filter((m) => !m.track_sites); const inj = ms.filter((m) => m.track_sites);
  const empty = !ms.length ? '<div class="panel"><p>Сьогодні нічого не заплановано.</p></div>' : '';
  return headerHtml() + weekHtml() +
    `<div class="sec"><h2>Сьогодні</h2><span class="tip">Картка — деталі, кнопка — швидко</span></div>
     <div class="list">${pills.map(medCardHtml).join('')}</div>` + inj.map(injHtml).join('') + empty;
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
    if (r && r.status === 'taken') { st = timeOf(r) + (r.dose && m.dose_options?.length ? ` · ${r.dose} таб.` : '') + (r.site ? ` · ${r.site}` : ''); col = '#c6f36b'; }
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
    <div class="panel"><h3>На головний екран</h3><p>iPhone: Safari → «Поділитися» → «На екран „Додому“». Android: Chrome → ⋮ → «Додати на головний екран».</p></div>
    <div class="panel"><button class="btn ghost" data-a="logout">Вийти з акаунта</button></div>`;
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
function openSheet(medId, day) {
  const m = S.meds.find((x) => x.id === medId); if (!m) return;
  const today = todayStr();
  S.sheet = { m, day, edit: false, mode: day === today ? 'now' : 'custom', time: day === today ? hm(new Date()) : planHM(m),
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
    const t = r.status === 'skipped' ? 'Відмічено як пропуск' : `Відмічено о ${timeOf(r)}` + (r.dose && m.dose_options?.length ? ` · ${r.dose} таб.` : '') + (r.site ? ` · ${r.site}` : '');
    body = `<div class="done-box ${r.status === 'skipped' ? 'skip' : ''}">${esc(t)}${r.note ? '<br>' + esc(r.note) : ''}${r.source === 'telegram' ? '<br><small>через Telegram</small>' : ''}</div>
      <button class="btn ghost" data-a="sedit">Змінити</button>
      <button class="btn link" data-a="sdel">Скасувати відмітку</button>`;
  } else {
    const doses = m.dose_options?.length ? `<div class="lbl">Скільки таблеток<div class="opts">${m.dose_options.map((n) => `<button class="opt ${sh.dose === n ? 'on' : ''}" data-a="sdose" data-v="${n}">${n} таблетки</button>`).join('')}</div></div>` : '';
    const sug = m.track_sites ? suggestSite(m) : null; const ls = m.track_sites ? lastSite(m) : null;
    const sites = m.track_sites ? `<div class="lbl">Місце уколу<div class="opts">${SITES.map((s) => `<button class="opt ${sh.site === s ? 'on' : ''}" data-a="ssite" data-v="${esc(s)}">${esc(s)}${s === sug ? '<small>за чергуванням</small>' : ''}</button>`).join('')}</div>
      <span style="font-weight:500;font-size:12px;color:var(--muted)">${ls ? 'Минулого разу: ' + esc(ls.site) + ', ' + esc(fmtDay(ls.day, { day: 'numeric', month: 'long' })) : 'Перший укол — з нього почнеться історія місць'}</span></div>` : '';
    const timeSel = day === today
      ? `<div class="opts"><button class="opt ${sh.mode === 'now' ? 'on' : ''}" data-a="smode" data-v="now">Зараз · ${hm(new Date())}</button><button class="opt ${sh.mode === 'custom' ? 'on' : ''}" data-a="smode" data-v="custom">Вказати час</button></div>` : '';
    const timeIn = sh.mode === 'custom' ? `<label class="row">Коли<input type="time" data-in="time" value="${esc(sh.time)}"></label>` : '';
    const tShow = sh.mode === 'now' ? hm(new Date()) : sh.time;
    body = `${doses}${sites}${timeSel}${timeIn}
      <label class="lbl">Коментар (не обовʼязково)<textarea rows="2" data-in="note" placeholder="Наприклад: поїла раніше, нудило…">${esc(sh.note)}</textarea></label>
      <button class="btn" data-a="ssave">${m.track_sites ? 'Відмітити укол' : 'Прийняла'} · ${tShow}</button>
      <button class="btn link" data-a="sskip">${day === today ? 'Пропускаю сьогодні' : 'Відмітити як пропуск'}</button>`;
  }
  root.innerHTML = `<div class="ov" role="dialog" aria-modal="true" aria-label="${esc(m.name)}"><button class="bg" data-a="sclose" aria-label="Закрити"></button>
    <div class="sh"><span class="grab"></span><div><div class="ttl">${esc(m.name)}</div><div class="sub">${esc(m.dose_label)} · ${esc(dayLbl)} · план ${planHM(m)}${m.note ? ' · ' + esc(m.note) : ''}</div></div>${body}</div></div>`;
}

// ---------- med editor ----------
const COLORS = ['#e6a700', '#3fa3e0', '#e66aa8', '#6c5ce7', '#2bb39a', '#f0784a', '#8a7f9e'];
function openEditor(id) {
  const m = id ? S.meds.find((x) => x.id === id) : null;
  S.ed = m ? {
    id: m.id, name: m.name, inj: !!m.track_sites, dose_label: m.dose_label, doses: (m.dose_options || []).join(', '),
    kind: m.kind, weekdays: [...wdays(m)], interval_days: m.interval_days || 2, start_date: m.start_date || todayStr(),
    plan_time: planHM(m), window_label: m.window_label || '', note: m.note || '', color: m.color,
    remind: m.remind_before_min, follow: m.followup_after_min, active: m.active, confirmDel: false, err: ''
  } : { id: null, name: '', inj: false, dose_label: '', doses: '', kind: 'daily', weekdays: [], interval_days: 2, start_date: todayStr(),
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
      ? `<div class="row">Кожні<input type="number" min="2" max="365" inputmode="numeric" data-ein="interval_days" value="${e.interval_days}" style="width:90px">днів</div>
         <label class="row">Починаючи з<input type="date" data-ein="start_date" value="${esc(e.start_date)}"></label>` : '';
  root.innerHTML = `<div class="ov" role="dialog" aria-modal="true" aria-label="Ліки"><button class="bg" data-a="edclose" aria-label="Закрити"></button>
    <div class="sh"><span class="grab"></span><div class="ttl">${e.id ? 'Змінити ліки' : 'Нові ліки'}</div>
    <label class="lbl">Назва<input type="text" data-ein="name" value="${esc(e.name)}" placeholder="Напр. Вітамін D"></label>
    <div class="lbl">Тип${seg('inj', [[false, 'Таблетки'], [true, 'Укол']])}</div>
    <label class="lbl">Дозування<input type="text" data-ein="dose_label" value="${esc(e.dose_label)}" placeholder="Напр. 2 × 50 мг або 1 таблетка"></label>
    ${e.inj ? '' : `<label class="lbl">Варіанти кількості (необовʼязково)<input type="text" inputmode="numeric" data-ein="doses" value="${esc(e.doses)}" placeholder="Напр. 2, 3 — зʼявляться кнопки вибору"></label>`}
    <div class="lbl">Періодичність${seg('kind', [['daily', 'Щодня'], ['weekly', 'Дні тижня'], ['interval', 'Кожні N днів']])}${sched}</div>
    <label class="row">Час прийому<input type="time" data-ein="plan_time" value="${esc(e.plan_time)}"></label>
    <label class="lbl">Проміжок (необовʼязково)<input type="text" data-ein="window_label" value="${esc(e.window_label)}" placeholder="Напр. 9:00–10:00"></label>
    <label class="lbl">Примітка<input type="text" data-ein="note" value="${esc(e.note)}" placeholder="Напр. після їжі / за 2 год до їжі"></label>
    <div class="lbl">Колір<div class="colors">${COLORS.map((c) => `<button type="button" class="clr ${e.color === c ? 'on' : ''}" style="background:${c}" data-a="edcolor" data-v="${c}" aria-label="Колір"></button>`).join('')}</div></div>
    <label class="row">Нагадати за${sel('remind', [0, 5, 10, 15, 30, 60], (v) => v ? v + ' хв' : 'у час прийому')}</label>
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
  const doses = e.inj ? [] : e.doses.split(/[,;\s]+/).map(Number).filter((n) => n > 0 && n < 100);
  const row = {
    name: e.name.trim(), dose_label: e.dose_label.trim(), dose_options: doses.length ? doses : null, track_sites: e.inj,
    kind: e.kind, weekdays: e.kind === 'weekly' ? e.weekdays : null, weekday: e.kind === 'weekly' ? e.weekdays[0] : null,
    interval_days: e.kind === 'interval' ? iv : null, start_date: e.kind === 'interval' ? e.start_date : null,
    plan_time: e.plan_time, window_label: e.window_label.trim() || null, note: e.note.trim() || null, color: e.color,
    remind_before_min: Number(e.remind), followup_after_min: Number(e.follow), active: e.active
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

// ---------- render ----------
function render() {
  if (!S.user) return;
  const v = S.view === 'history' ? historyView() : S.view === 'meds' ? medsView() : todayView();
  $('#app').innerHTML = `<main class="wrap">${v}</main>${navHtml()}`;
  if (S.sheet) renderSheet();
  if (S.quick) renderQuick();
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a; const sh = S.sheet;
  if (a === 'nav') { S.view = el.dataset.v; if (S.view === 'history') { S.sel = null; S.month = null; } render(); window.scrollTo(0, 0); }
  else if (a === 'open') openSheet(el.dataset.id, el.dataset.day);
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
    S.sheet = null; renderSheet();
    await saveIntake(m, day, { status: 'taken', taken_at: takenAtFor(day, t), dose: m.dose_options?.length ? sh.dose : null, site: m.track_sites ? sh.site : null, note: sh.note.trim() || null });
    toast(`${m.name} — відмічено о ${t}`);
  }
  else if (a === 'sskip') {
    const { m, day } = sh; S.sheet = null; renderSheet();
    await saveIntake(m, day, { status: 'skipped', taken_at: null, dose: null, site: null, note: sh.note.trim() || null });
    toast(`${m.name} — пропуск записано`);
  }
});

document.addEventListener('input', (e) => {
  const ef = e.target.dataset?.ein; if (ef && S.ed) { S.ed[ef] = e.target.value; return; }
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
  try { await ensureSeed(); await Promise.all([loadAll(), checkPush()]); lastLoad = Date.now(); render(); if (new URL(location.href).searchParams.get('q')) { await takePending(); openQuickFromUrl(); } else checkPendingQuick(); }
  catch (err) { $('#app').innerHTML = `<div class="login"><h1>Ой</h1><p>Не вдалося завантажити дані. Перевір інтернет і онови сторінку.</p><p class="err">${esc(err.message || err)}</p></div>`; }
}

let booted = false;
sb.auth.onAuthStateChange((ev, session) => {
  if (ev === 'SIGNED_IN' && !S.user) boot(session);
  else if (ev === 'SIGNED_OUT') { S.user = null; $('#app').innerHTML = loginView(); }
  else if (ev === 'INITIAL_SESSION' && !booted) { booted = true; boot(session); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
