import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

// GET /api/search?q=<terme>
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const q = (req.query['q'] as string | undefined)?.trim() ?? '';
  if (q.length < 2) {
    res.json({ personnes: [], stories: [], unions: [] });
    return;
  }

  const familleId = req.user!.familleId;
  const like = { contains: q, mode: 'insensitive' as const };

  try {
    const [personnes, stories, unions] = await Promise.all([
      prisma.personne.findMany({
        where: {
          familleId,
          OR: [
            { prenoms:       like },
            { nomNaissance:  like },
            { nomUsage:      like },
            { lieuNaissance: like },
            { biographie:    like },
          ],
        },
        select: {
          id: true, prenoms: true, nomNaissance: true, nomUsage: true,
          sexe: true, dateNaissance: true, lieuNaissance: true, photoUrl: true,
        },
        take: 6,
      }),

      prisma.story.findMany({
        where: {
          familleId,
          OR: [
            { titre:   like },
            { caption: like },
            { tag:     like },
          ],
        },
        select: {
          id: true, titre: true, caption: true, tag: true,
          mediaUrl: true, mediaType: true, createdAt: true,
        },
        take: 5,
      }),

      prisma.union.findMany({
        where: {
          familleId,
          notes: like,
        },
        select: {
          id: true, type: true, dateDebut: true, notes: true,
          participants: {
            select: {
              personne: {
                select: { id: true, prenoms: true, nomNaissance: true, photoUrl: true },
              },
            },
          },
        },
        take: 4,
      }),
    ]);

    res.json({ personnes, stories, unions });
  } catch (err) {
    console.error('[search]', err);
    res.status(500).json({ error: 'Erreur recherche' });
  }
});

export default router;
