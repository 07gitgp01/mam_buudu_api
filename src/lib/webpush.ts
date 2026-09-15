import webpush from 'web-push';
import { PushSubscription } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';

const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject    = process.env.VAPID_SUBJECT || 'mailto:support@mam-buudu.com';

const configured = !!(vapidPublicKey && vapidPrivateKey);
if (configured) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey!, vapidPrivateKey!);
} else {
  logger.warn('[webpush] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY absents — notifications push désactivées');
}

export function getVapidPublicKey(): string | null {
  return vapidPublicKey ?? null;
}

interface PushPayload {
  type: string;
  title: string;
  body: string;
  url?: string;
}

/** Un abonnement filtre lui-même ses types : tableau vide = tout recevoir. */
function acceptsType(sub: Pick<PushSubscription, 'types'>, type: string): boolean {
  return sub.types.length === 0 || sub.types.includes(type);
}

async function dispatch(subs: PushSubscription[], payload: PushPayload): Promise<void> {
  const targets = subs.filter(s => acceptsType(s, payload.type));
  if (targets.length === 0) return;

  const body = JSON.stringify({
    notification: {
      title: payload.title,
      body:  payload.body,
      icon:  '/favicon.ico', // les icônes PWA (icons/icon-*.png) référencées par le manifest n'existent pas encore sur le disque
      data:  { url: payload.url ?? '/' },
    },
  });

  await Promise.all(targets.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      );
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        logger.warn({ err, subscriptionId: sub.id }, '[webpush] envoi échoué');
      }
    }
  }));
}

/**
 * Envoie une notification push aux comptes réels listés (userIds).
 * N'échoue jamais l'appelant : chaque échec est loggé, les abonnements
 * expirés/invalides (410/404) sont supprimés silencieusement.
 */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  if (!configured || userIds.length === 0) return;
  try {
    const subs = await prisma.pushSubscription.findMany({ where: { userId: { in: userIds } } });
    await dispatch(subs, payload);
  } catch (err) {
    logger.error({ err }, '[webpush] sendPushToUsers error');
  }
}

/**
 * Envoie une notification push aux appareils abonnés en accès lecture-seule
 * pour cette famille (pas de compte personnel, un abonnement par appareil).
 */
export async function sendPushToFamilleViewonly(familleId: string, payload: PushPayload): Promise<void> {
  if (!configured) return;
  try {
    const subs = await prisma.pushSubscription.findMany({ where: { familleId, userId: null } });
    await dispatch(subs, payload);
  } catch (err) {
    logger.error({ err }, '[webpush] sendPushToFamilleViewonly error');
  }
}
