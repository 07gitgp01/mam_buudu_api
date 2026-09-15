import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { sendPushToUsers, sendPushToFamilleViewonly } from './webpush';

interface NotifPayload {
  type: string;
  titre: string;
  message: string;
  data?: Prisma.InputJsonValue;
  url?: string;
}

/**
 * Notifie les membres d'une famille (sauf exceptUserId).
 * Si `targetUserIds` est fourni, restreint l'envoi à ces utilisateurs précis
 * (intersection avec les membres réels de la famille) — permet à un créateur
 * de contenu de choisir qui doit être notifié plutôt que toute la famille.
 * Les abonnés en accès lecture-seule de la famille sont toujours inclus côté
 * push (ils n'ont pas de compte, donc pas de notification in-app dédiée).
 */
export async function notifyFamille(
  familleId: string,
  exceptUserId: string | null,
  payload: NotifPayload,
  targetUserIds?: string[] | null,
): Promise<void> {
  try {
    const membres = await prisma.familleMembre.findMany({
      where: { familleId },
      select: { userId: true },
    });
    let targets = membres
      .map(m => m.userId)
      .filter(uid => uid !== exceptUserId);

    if (targetUserIds && targetUserIds.length > 0) {
      const restrict = new Set(targetUserIds);
      targets = targets.filter(uid => restrict.has(uid));
    }

    if (targets.length > 0) {
      await prisma.notification.createMany({
        data: targets.map(userId => ({
          familleId,
          userId,
          type:    payload.type,
          titre:   payload.titre,
          message: payload.message,
          data:    payload.data ?? Prisma.JsonNull,
        })),
        skipDuplicates: true,
      });

      sendPushToUsers(targets, { type: payload.type, title: payload.titre, body: payload.message, url: payload.url });
    }

    // Les liens lecture-seule ne sont jamais une "cible choisie" explicitement
    // (ils n'apparaissent pas dans targetUserIds) — mais tant que l'envoi n'est
    // pas restreint à des personnes précises, on les inclut par défaut.
    if (!targetUserIds || targetUserIds.length === 0) {
      sendPushToFamilleViewonly(familleId, { type: payload.type, title: payload.titre, body: payload.message, url: payload.url });
    }
  } catch (err) {
    logger.error({ err }, '[notifications] notifyFamille error');
  }
}

/** Notifie un seul utilisateur */
export async function notifyUser(
  userId: string,
  familleId: string,
  payload: NotifPayload,
): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        familleId,
        userId,
        type:    payload.type,
        titre:   payload.titre,
        message: payload.message,
        data:    payload.data ?? Prisma.JsonNull,
      },
    });

    sendPushToUsers([userId], { type: payload.type, title: payload.titre, body: payload.message, url: payload.url });
  } catch (err) {
    logger.error({ err }, '[notifications] notifyUser error');
  }
}

/** Notifie tous les admins d'une famille */
export async function notifyAdmins(
  familleId: string,
  payload: NotifPayload,
): Promise<void> {
  try {
    const admins = await prisma.familleMembre.findMany({
      where: { familleId, role: 'admin' },
      select: { userId: true },
    });
    if (!admins.length) return;

    await prisma.notification.createMany({
      data: admins.map(a => ({
        familleId,
        userId:  a.userId,
        type:    payload.type,
        titre:   payload.titre,
        message: payload.message,
        data:    payload.data ?? Prisma.JsonNull,
      })),
      skipDuplicates: true,
    });

    sendPushToUsers(admins.map(a => a.userId), { type: payload.type, title: payload.titre, body: payload.message, url: payload.url });
  } catch (err) {
    logger.error({ err }, '[notifications] notifyAdmins error');
  }
}
