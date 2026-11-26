// הגדרות ציבוריות שהאפליקציה בדפדפן צריכה: כתובת המסד, המפתח הציבורי, ומפתח הפוש הציבורי.
import { env, rpc, send, handler, serverConfig, whatsappReady } from './_lib.js';

let cache = { at: 0, vapid: null, whatsapp: false };

export default handler(async (req, res) => {
  if (!cache.vapid || Date.now() - cache.at > 300_000) {
    // whatsapp: האם תזכורות בוואטסאפ באמת נשלחות (כדי לא להבטיח ללקוחה תזכורת שלא תגיע).
    let whatsapp = false;
    try {
      const cfg = await serverConfig();
      whatsapp = whatsappReady(cfg) && Boolean(cfg.wa_tpl_reminder);
    } catch (e) {
      console.error(e);
    }
    cache = { at: Date.now(), vapid: await rpc('push_public_key'), whatsapp };
  }
  send(res, 200, {
    supabaseUrl: env.url,
    supabaseKey: env.anon,
    slug: env.slug,
    demoLogin: env.demoLogin,
    vapidPublic: cache.vapid,
    whatsapp: cache.whatsapp,
  });
});
