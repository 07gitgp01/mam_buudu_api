import { Router, Response, Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';
import { getVapidPublicKey } from '../lib/webpush';
import { logger } from '../lib/logger';

const router = Router();

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth:   z.string().min(1),
  }),
});

/**
 * @openapi
 * /api/push/vapid-public-key:
 *   get:
 *     tags: [Push]
 *     summary: Clé publique VAPID à utiliser côté navigateur pour s'abonner aux notifications
 *     security: []
 *     responses:
 *       200: { description: "{ publicKey }" }
 *       503: { description: "Push non configuré côté serveur" }
 */
router.get('/vapid-public-key', (_req: Request, res: Response): void => {
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    res.status(503).json({ error: 'Notifications push non configurées côté serveur' });
    return;
  }
  res.json({ publicKey });
});

router.use(requireAuth);

/**
 * @openapi
 * /api/push/subscribe:
 *   post:
 *     tags: [Push]
 *     summary: Enregistre un abonnement navigateur (PushSubscription) pour l'utilisateur connecté
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Abonnement enregistré }
 *       400: { description: Données invalides }
 */
router.post('/subscribe', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = subscribeSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Abonnement push invalide' });
    return;
  }
  const { endpoint, keys } = parse.data;

  try {
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth },
      create: { userId: req.user!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[push subscribe]');
    res.status(500).json({ error: 'Erreur lors de l\'enregistrement' });
  }
});

/**
 * @openapi
 * /api/push/subscribe:
 *   delete:
 *     tags: [Push]
 *     summary: Supprime un abonnement navigateur (désactivation des notifications sur cet appareil)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Abonnement supprimé }
 */
router.delete('/subscribe', async (req: AuthRequest, res: Response): Promise<void> => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;
  if (!endpoint) {
    res.status(400).json({ error: 'endpoint requis' });
    return;
  }
  try {
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user!.id } });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[push unsubscribe]');
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

export default router;
