import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

// ── GET /api/notifications ────────────────────────────────────────────────────
// Retourne les 30 dernières notifications de l'utilisateur (non lues en premier)
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ lue: 'asc' }, { createdAt: 'desc' }],
      take: 30,
    });

    const nonLues = notifications.filter(n => !n.lue).length;
    res.json({ notifications, nonLues });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /api/notifications/tout-lire ────────────────────────────────────────
router.patch('/tout-lire', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, lue: false },
      data:  { lue: true },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /api/notifications/:id/lire ─────────────────────────────────────────
router.patch('/:id/lire', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const notif = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!notif) { res.status(404).json({ error: 'Introuvable' }); return; }

    await prisma.notification.update({
      where: { id: req.params.id },
      data:  { lue: true },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /api/notifications/:id ─────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const notif = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!notif) { res.status(404).json({ error: 'Introuvable' }); return; }

    await prisma.notification.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
