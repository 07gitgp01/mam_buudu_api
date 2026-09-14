import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireManage } from '../middleware/auth';
import { AuthRequest } from '../types';
import { logActivity } from '../lib/activityLog';

const router = Router();
router.use(requireAuth);

const eventSchema = z.object({
  titre:       z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  type:        z.enum(['naissance', 'mariage', 'deces', 'succes', 'voyage', 'autre']).default('autre'),
  date:        z.string().min(4).max(10), // YYYY, YYYY-MM ou YYYY-MM-DD
  personne:    z.string().max(200).optional().nullable(),
});

/**
 * @openapi
 * /api/timeline:
 *   get:
 *     tags: [Timeline]
 *     summary: Liste les événements chronologiques de la famille (jusqu'à 500)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Liste des événements }
 *   post:
 *     tags: [Timeline]
 *     summary: Crée un événement (admin/gestionnaire uniquement)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Événement créé }
 *       400: { description: Données invalides }
 */
// ── GET /api/timeline ─────────────────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const events = await prisma.timelineEvent.findMany({
      where: { familleId: req.user!.familleId },
      orderBy: { date: 'asc' },
      take: 500, // garde-fou : la vue fusionne ces événements avec ceux auto-générés (naissances/décès) et les trie en une fois, pas de pagination possible ici
    });
    res.json(events);
  } catch (err) {
    console.error('[timeline GET]', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── POST /api/timeline ────────────────────────────────────────────────────────
router.post('/', requireManage, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.isViewonly) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }

  const parse = eventSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  try {
    const event = await prisma.timelineEvent.create({
      data: {
        familleId:   req.user!.familleId,
        creatorId:   req.user!.id,
        titre:       parse.data.titre,
        description: parse.data.description ?? null,
        type:        parse.data.type,
        date:        parse.data.date,
        personne:    parse.data.personne ?? null,
      },
    });
    res.status(201).json(event);

    logActivity({
      familleId: req.user!.familleId,
      userId:    req.user!.id,
      action:    'create_event',
      targetType: 'timeline_event',
      targetId:  event.id,
      details:   { titre: event.titre },
    });
  } catch (err) {
    console.error('[timeline POST]', err);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// ── PUT /api/timeline/:id ─────────────────────────────────────────────────────
router.put('/:id', requireManage, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.isViewonly) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }

  const parse = eventSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  try {
    const existing = await prisma.timelineEvent.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Événement introuvable' });
      return;
    }

    const updated = await prisma.timelineEvent.update({
      where: { id: req.params.id },
      data: {
        titre:       parse.data.titre,
        description: parse.data.description ?? null,
        type:        parse.data.type,
        date:        parse.data.date,
        personne:    parse.data.personne ?? null,
      },
    });
    res.json(updated);

    logActivity({
      familleId: req.user!.familleId,
      userId:    req.user!.id,
      action:    'update_event',
      targetType: 'timeline_event',
      targetId:  updated.id,
      details:   { titre: updated.titre },
    });
  } catch (err) {
    console.error('[timeline PUT]', err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

// ── DELETE /api/timeline/:id ──────────────────────────────────────────────────
router.delete('/:id', requireManage, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.isViewonly) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }

  try {
    const existing = await prisma.timelineEvent.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Événement introuvable' });
      return;
    }

    await prisma.timelineEvent.delete({ where: { id: req.params.id } });
    res.status(204).send();

    logActivity({
      familleId: req.user!.familleId,
      userId:    req.user!.id,
      action:    'delete_event',
      targetType: 'timeline_event',
      targetId:  existing.id,
      details:   { titre: existing.titre },
    });
  } catch (err) {
    console.error('[timeline DELETE]', err);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

export default router;
