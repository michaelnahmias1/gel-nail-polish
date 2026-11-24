// שליחת ההודעות שממתינות בתור: וואטסאפ ללקוחה (אישור, תזכורת) ופוש לבעלת העסק.
// המסד "מעיר" את הפונקציה הזו בכל קביעה/ביטול, ובנוסף כל 5 דקות (pg_cron + pg_net).

import { timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';
import {
  env, rpc, serverConfig, whatsappReady, sendWhatsappTemplate, send, handler, HttpError,
} from './_lib.js';

function secretOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(env.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pushText(job) {
  const when = `${job.day_text} ${job.date_text} ב-${job.time_text}`;
  switch (job.kind) {
    case 'owner_booked':
      return { title: 'תור חדש', body: `${job.customer_name} · ${job.services_text}\n${when}`, url: `/#/owner?d=${job.local_date}` };
    case 'owner_cancelled':
      return { title: 'תור בוטל', body: `${job.customer_name} ביטלה את התור של ${when}`, url: `/#/owner?d=${job.local_date}` };
    case 'owner_test':
      return { title: 'ההתראות עובדות', body: 'מעכשיו תקבלי כאן הודעה על כל תור חדש או ביטול.', url: '/#/owner' };
    default:
      return null;
  }
}

async function sendPush(cfg, job) {
  if (!cfg.vapid_public || !cfg.vapid_private) return ['skipped', 'push_not_configured'];
  const targets = await rpc('srv_owner_push_targets', { p_secret: env.secret, p_business: job.business_id });
  if (!targets.length) return ['skipped', 'no_owner_devices'];
  webpush.setVapidDetails(cfg.vapid_subject || 'mailto:owner@example.com', cfg.vapid_public, cfg.vapid_private);
  const payload = JSON.stringify(pushText(job));
  let delivered = 0;
  let lastError = null;
  for (const t of targets) {
    try {
      await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, payload, { TTL: 86400 });
      delivered++;
    } catch (e) {
      lastError = `${e.statusCode || ''} ${e.body || e.message}`.slice(0, 300);
      if (e.statusCode === 404 || e.statusCode === 410) {
        await rpc('srv_push_remove', { p_secret: env.secret, p_endpoint: t.endpoint });
      }
    }
  }
  return delivered ? ['sent', null] : ['failed', lastError];
}

async function sendCustomer(cfg, job) {
  if (job.appointment_status !== 'booked') return ['skipped', 'appointment_cancelled'];
  if (!job.customer_phone) return ['skipped', 'no_phone'];
  if (!whatsappReady(cfg)) return ['skipped', 'whatsapp_not_configured'];
  const tpl = job.kind === 'customer_confirm' ? cfg.wa_tpl_confirm : cfg.wa_tpl_reminder;
  if (!tpl) return ['skipped', 'template_not_configured'];
  // סדר המשתנים בתבנית: {{1}} שם, {{2}} טיפולים, {{3}} יום, {{4}} תאריך, {{5}} שעה
  await sendWhatsappTemplate(cfg, job.customer_phone, tpl,
    [job.customer_name, job.services_text, job.day_text, job.date_text, job.time_text]);
  return ['sent', null];
}

export default handler(async (req, res) => {
  if (!secretOk(req.headers['x-dispatch-secret'])) throw new HttpError(401, 'FORBIDDEN');
  const cfg = await serverConfig();
  const summary = { sent: 0, skipped: 0, failed: 0 };

  for (let round = 0; round < 5; round++) {
    const jobs = await rpc('srv_notifications_claim', { p_secret: env.secret, p_limit: 20 });
    if (!jobs.length) break;
    for (const job of jobs) {
      let status;
      let error;
      try {
        [status, error] = job.kind.startsWith('owner_') ? await sendPush(cfg, job) : await sendCustomer(cfg, job);
      } catch (e) {
        status = 'failed';
        error = String(e.message || e).slice(0, 300);
      }
      summary[status]++;
      await rpc('srv_notification_done', { p_secret: env.secret, p_id: job.id, p_status: status, p_error: error });
    }
  }
  send(res, 200, summary);
});
