// כניסה בקוד חד-פעמי.
// POST {action: 'start', phone}        → שולח קוד בוואטסאפ (או, במצב בדיקה, מחזיר אותו)
// POST {action: 'finish', phone, code} → מחזיר חיבור (session) של Supabase

import { randomInt } from 'node:crypto';
import {
  env, rpc, passwordGrant, serverConfig, whatsappReady, sendWhatsappTemplate,
  readJson, send, handler, HttpError,
} from './_lib.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'METHOD');
  const body = await readJson(req);
  const phone = String(body.phone || '').slice(0, 30);

  if (body.action === 'start') {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const r = await rpc('srv_login_start', { p_secret: env.secret, p_slug: env.slug, p_phone: phone, p_code: code });
    if (r.status !== 'ok') return send(res, 200, { status: r.status });

    const cfg = await serverConfig();
    if (whatsappReady(cfg) && cfg.wa_tpl_code) {
      try {
        await sendWhatsappTemplate(cfg, r.phone, cfg.wa_tpl_code, [code], code);
        return send(res, 200, { status: 'ok', channel: 'whatsapp' });
      } catch (e) {
        console.error(e);
        if (!env.demoLogin) return send(res, 200, { status: 'send_failed' });
      }
    }
    if (env.demoLogin) return send(res, 200, { status: 'ok', channel: 'demo', demoCode: code });
    return send(res, 200, { status: 'no_channel' });
  }

  if (body.action === 'finish') {
    const code = String(body.code || '').replace(/\D/g, '').slice(0, 8);
    const r = await rpc('srv_login_finish', { p_secret: env.secret, p_slug: env.slug, p_phone: phone, p_code: code });
    if (!r.ok) return send(res, 200, { status: 'bad_code' });
    const session = await passwordGrant(r.email, r.password);
    return send(res, 200, {
      status: 'ok',
      role: r.role,
      hasName: r.has_name,
      session: { access_token: session.access_token, refresh_token: session.refresh_token },
    });
  }

  throw new HttpError(400, 'BAD_ACTION');
});
