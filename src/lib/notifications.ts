import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

interface NotifPayload {
  type: string;
  titre: string;
  message: string;
  data?: Prisma.InputJsonValue;
}

/** Notifie tous les membres d'une famille (sauf exceptUserId) */
export async function notifyFamille(
  familleId: string,
  exceptUserId: string | null,
  payload: NotifPayload,
): Promise<void> {
  try {
    const membres = await prisma.familleMembre.findMany({
      where: { familleId },
      select: { userId: true },
    });
    const targets = membres
      .map(m => m.userId)
      .filter(uid => uid !== exceptUserId);
    if (!targets.length) return;

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
  } catch (err) {
    console.error('[notifications] notifyFamille error:', err);
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
  } catch (err) {
    console.error('[notifications] notifyUser error:', err);
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
  } catch (err) {
    console.error('[notifications] notifyAdmins error:', err);
  }
}
