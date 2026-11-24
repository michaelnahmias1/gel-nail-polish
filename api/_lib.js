// עזרים משותפים לפונקציות השרת ב-Vercel.
// השרת מדבר עם Supabase רק דרך ה-API הציבורי, עם המפתח הציבורי (anon) + סוד משותף לפונקציות השער.

export const env = {
  url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  anon: process.env.SUPABASE_ANON_KEY || '',
  secret: process.env.SERVER_SECRET || '',
  slug: process.env.BUSINESS_SLUG || 'main',
  // מצב בדיקה: כשאין עדיין ערוץ וואטסאפ, הקוד מוצג על המסך. לכבות לפני השקה אמיתית.
  demoLogin: process.env.DEMO_LOGIN === '1',
};

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function rpc(fn, args = {}, token) {
  const res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.anon,
      Authorization: `Bearer ${token || env.anon}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message || `rpc ${fn} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function passwordGrant(email, password) {
  const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`auth failed: ${res.status} ${data?.msg || data?.error_description || ''}`);
  return data;
}

let configCache = { at: 0, value: null };

// ההגדרות הסודיות של השרת (וואטסאפ, מפתחות פוש) שמורות במסד, בטבלה סגורה.
export async function serverConfig() {
  if (configCache.value && Date.now() - configCache.at < 60_000) return configCache.value;
  const value = await rpc('srv_config', { p_secret: env.secret });
  configCache = { at: Date.now(), value };
  return value;
}

export function whatsappReady(cfg) {
  return Boolean(cfg.wa_token && cfg.wa_phone_number_id);
}

// שליחת הודעת תבנית דרך WhatsApp Cloud API (הערוץ הרשמי של Meta).
export async function sendWhatsappTemplate(cfg, toPhone, template, bodyParams, buttonParam) {
  const components = [];
  if (bodyParams?.length) {
    components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) });
  }
  if (buttonParam != null) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(buttonParam) }] });
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.wa_phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.wa_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone.replace(/^\+/, ''),
      type: 'template',
      template: { name: template, language: { code: cfg.wa_lang || 'he' }, components },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`whatsapp ${res.status}: ${body.slice(0, 300)}`);
  }
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length > 10_000) throw new HttpError(413, 'TOO_LARGE');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'BAD_JSON');
  }
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function handler(fn) {
  return async (req, res) => {
    try {
      if (!env.url || !env.anon || env.secret.length < 32) throw new HttpError(500, 'SERVER_NOT_CONFIGURED');
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code });
      console.error(e);
      send(res, 500, { error: 'SERVER_ERROR' });
    }
  };
}
