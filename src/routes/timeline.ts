import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

const eventSchema = z.object({
  titre:       z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  type:        z.enum(['naissance', 'mariage', 'deces', 'succes', 'voyage', 'autre']).default('autre'),
  date:        z.string().min(4).max(10), // YYYY, YYYY-MM ou YYYY-MM-DD
  personne:    z.string().max(200).optional().nullable(),
});

// ── GET /api/timeline ─────────────────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const events = await prisma.timelineEvent.findMany({
      where: { familleId: req.user!.familleId },
      orderBy: { date: 'asc' },
    });
    res.json(events);
  } catch (err) {
    console.error('[timeline GET]', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── POST /api/timeline ────────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
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
  } catch (err) {
    console.error('[timeline POST]', err);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// ── PUT /api/timeline/:id ─────────────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
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
  } catch (err) {
    console.error('[timeline PUT]', err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

// ── DELETE /api/timeline/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
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
  } catch (err) {
    console.error('[timeline DELETE]', err);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

export default router;
