import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export type ActivityAction =
  | 'create_personne' | 'update_personne' | 'delete_personne'
  | 'create_union' | 'delete_union'
  | 'create_story' | 'delete_story'
  | 'create_event' | 'update_event' | 'delete_event';

export type ActivityTargetType = 'personne' | 'union' | 'story' | 'timeline_event';

interface ActivityPayload {
  familleId: string;
  userId: string | null;
  action: ActivityAction;
  targetType: ActivityTargetType;
  targetId?: string | null;
  details?: Prisma.InputJsonValue;
}

/** Journalise une mutation famille (personnes/unions/stories/timeline). N'échoue jamais la requête appelante. */
export async function logActivity(payload: ActivityPayload): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        familleId:  payload.familleId,
        userId:     payload.userId,
        action:     payload.action,
        targetType: payload.targetType,
        targetId:   payload.targetId ?? null,
        details:    payload.details,
      },
    });
  } catch (e) {
    console.warn('[activityLog]', e);
  }
}
