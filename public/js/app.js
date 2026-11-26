// נקודת הכניסה: טוען הגדרות, מתחבר למסד, ומנתב בין המסכים לפי הכתובת (#/...).
import {
  h, mount, spinner, toast, header, setAppName, setRouter, trackNavigation, currentHash,
  go as navGo, goBack, goFrom, isOffline,
} from './ui.js';
import * as customer from './customer.js';
import * as owner from './owner.js';

export const state = {
  sb: null,          // חיבור Supabase
  cfg: null,         // הגדרות ציבוריות מהשרת
  business: null,    // {id, name, slug}
  settings: null,    // כללי העסק (כתובת, טלפון, חלון הזמנה...)
  profile: null,     // המשתמשת המחוברת
  services: [],      // המחירון
  draft: null,       // תור בתהליך קביעה: {items: [{service_id, qty}], start}
};

export const isOwner = () => state.profile?.role === 'owner';

export async function loadBusiness() {
  const { data: biz, error } = await state.sb.from('businesses').select('id, name, slug').eq('slug', state.cfg.slug).single();
  if (error) throw error;
  const [{ data: settings, error: e2 }, { data: services, error: e3 }] = await Promise.all([
    state.sb.from('settings').select('*').eq('business_id', biz.id).single(),
    state.sb.from('services').select('*').eq('business_id', biz.id).order('sort_order').order('created_at'),
  ]);
  if (e2) throw e2;
  if (e3) throw e3;
  state.business = biz;
  state.settings = settings;
  state.services = services;
  setAppName(biz.name);
  document.title = biz.name;
}

export async function loadProfile() {
  const { data: { session } } = await state.sb.auth.getSession();
  if (!session) {
    state.profile = null;
    return null;
  }
  const { data, error } = await state.sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) throw error;
  state.profile = data;
  return data;
}

export async function logout() {
  await state.sb.auth.signOut();
  state.profile = null;
  go('#/login', { replace: true });
}

// לאן להמשיך אחרי הכניסה (למשל מי שפתחה קישור ישיר ל-#/setup לפני שהתחברה).
const AFTER_LOGIN = 'gel-after-login';
function rememberTarget(hash) {
  try { sessionStorage.setItem(AFTER_LOGIN, hash); } catch { /* מצב פרטי */ }
}
export function afterLoginTarget({ consume = false } = {}) {
  let t = null;
  try {
    t = sessionStorage.getItem(AFTER_LOGIN);
    if (consume) sessionStorage.removeItem(AFTER_LOGIN);
  } catch { /* מצב פרטי */ }
  return t && t.startsWith('#/') ? t : '#/';
}

const routes = [
  [/^\/login$/, customer.login, { public: true }],
  [/^\/name$/, customer.askName],
  [/^\/$/, () => (isOwner() ? owner.calendar() : customer.home())],
  [/^\/book$/, customer.chooseServices],
  [/^\/book\/time$/, customer.chooseTime],
  [/^\/book\/confirm$/, customer.confirm],
  [/^\/booked$/, customer.booked],
  [/^\/mine$/, customer.mine],
  [/^\/setup$/, owner.claim],
  [/^\/owner$/, owner.calendar, { owner: true }],
  [/^\/owner\/new$/, owner.manualBooking, { owner: true }],
  [/^\/owner\/appt\/([\w-]+)$/, owner.appointment, { owner: true }],
  [/^\/owner\/settings$/, owner.settings, { owner: true }],
  [/^\/owner\/settings\/([a-z]+)$/, owner.settingsSection, { owner: true }],
];

const SLOW_MS = 15000;
let routeSeq = 0;

// מסך שגיאה: שומר את הכותרת של המסך שניסינו לפתוח, ומציע לנסות שוב או לחזור לדף הבית / ליומן.
function errorScreen(retry, { keepHeader = true } = {}) {
  const root = document.getElementById('app');
  const top = keepHeader ? root.querySelector('header.top') : null;
  const home = isOwner() ? '#/owner' : '#/';
  const atHome = ['#/', '#/owner', ''].includes(currentHash().split('?')[0]);
  mount(h('main.page', { 'data-title': 'שגיאה' },
    top || header('משהו השתבש'),
    h('div.card.stack.center-text',
      h('p.lead', { role: 'alert' }, isOffline() ? 'אין חיבור לאינטרנט כרגע.' : 'לא הצלחנו לטעון את המסך.'),
      h('p.muted', isOffline() ? 'כשהחיבור יחזור, אפשר לנסות שוב.' : 'אפשר לנסות שוב בעוד רגע.'),
      h('button.btn.primary', { type: 'button', onclick: retry }, 'לנסות שוב'),
      state.profile && !atHome
        ? h('button.btn.secondary', { type: 'button', onclick: () => goBack(home) }, isOwner() ? 'חזרה ליומן' : 'חזרה לדף הבית')
        : null)));
}

// אחרי ~15 שניות של טעינה: הודעה שזה לוקח יותר זמן, עם «לנסות שוב».
function slowNotice(seq, retry) {
  return setTimeout(() => {
    if (seq !== routeSeq) return;
    const root = document.getElementById('app');
    if (root.querySelector('.slow-note')) return;
    const page = root.querySelector('main') || root;
    page.append(h('div.slow-note.stack.center-text', { role: 'status' },
      h('p.muted', 'לוקח יותר זמן מהרגיל…'),
      h('button.btn.secondary', { type: 'button', onclick: retry }, 'לנסות שוב')));
  }, SLOW_MS);
}

async function route() {
  if (!trackNavigation()) return;
  const seq = ++routeSeq;
  const raw = currentHash().replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const match = routes.find(([re]) => re.test(path));
  if (!match) return go('#/', { replace: true });
  const [re, view, opts = {}] = match;

  if (!opts.public && !state.profile) {
    if (path !== '/') rememberTarget(currentHash());
    return go('#/login', { replace: true });
  }
  if (state.profile && !state.profile.name && path !== '/name' && !opts.public) {
    return go('#/name', { replace: true });
  }
  if (opts.owner && !isOwner()) return go('#/', { replace: true });

  const slow = slowNotice(seq, () => route());
  try {
    await view(params, ...(path.match(re).slice(1)));
  } catch (e) {
    console.error(e);
    if (seq === routeSeq) errorScreen(() => route());
  } finally {
    clearTimeout(slow);
  }
}

// go('#/x') — מעבר; go('#/x', {replace: true}) — הפניה שמחליפה את הצעד הנוכחי (ראו ui.js).
export const go = navGo;
export { goBack, goFrom };

async function boot() {
  setRouter(route);
  mount(h('main.page.center', spinner()));
  const slow = setTimeout(() => {
    document.getElementById('app').append(h('div.slow-note.stack.center-text', { role: 'status' },
      h('p.muted', 'לוקח יותר זמן מהרגיל…'),
      h('button.btn.secondary', { type: 'button', onclick: () => location.reload() }, 'לנסות שוב')));
  }, SLOW_MS);
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('config ' + res.status);
    state.cfg = await res.json();
    state.sb = window.supabase.createClient(state.cfg.supabaseUrl, state.cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'gel-auth' },
    });
    await Promise.all([loadBusiness(), loadProfile()]);
  } catch (e) {
    console.error(e);
    mount(h('main.page.center', { 'data-title': 'שגיאה' },
      h('p.lead', { role: 'alert' }, isOffline() ? 'אין חיבור לאינטרנט כרגע.' : 'לא הצלחנו לטעון את האפליקציה.'),
      h('p.muted', isOffline() ? 'כשהחיבור יחזור, אפשר לנסות שוב.' : 'אפשר לנסות שוב בעוד רגע.'),
      h('button.btn.primary', { type: 'button', onclick: () => location.reload() }, 'לנסות שוב')));
    return;
  } finally {
    clearTimeout(slow);
  }

  state.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.profile = null;
      if (!currentHash().startsWith('#/login')) go('#/login', { replace: true });
    }
  });
  window.addEventListener('hashchange', route);
  await route();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw', e));
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'navigate' && ev.data.url) location.hash = ev.data.url.replace(/^\/?/, '').replace(/^#?/, '#');
  });
}
window.addEventListener('offline', () => toast('אין חיבור לאינטרנט', 'error'));

boot();
