import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireEdit } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

// ── Schéma Personne ─────────────────────────────
const personneSchema = z.object({
  id: z.string().uuid().optional(),           // fourni par le client (UUID local SQLite)
  nomNaissance: z.string().optional().nullable(),
  nomUsage: z.string().optional().nullable(),
  prenoms: z.string().optional().nullable(),
  sexe: z.enum(['M', 'F', 'autre']).optional().nullable(),
  dateNaissance: z.string().optional().nullable(), // YYYY, YYYY-MM ou YYYY-MM-DD
  lieuNaissance: z.string().optional().nullable(),
  dateDeces: z.string().optional().nullable(),
  lieuDeces: z.string().optional().nullable(),
  biographie: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  photoUrl: z.string().url().optional().nullable(),
});

// ── GET /api/personnes ──────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const personnes = await prisma.personne.findMany({
      where: { familleId: req.user!.familleId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(personnes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── GET /api/personnes/:id ──────────────────────
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const personne = await prisma.personne.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
      include: {
        unionParticipants: {
          include: {
            union: {
              include: {
                participants: { include: { personne: true } },
                filiations: { include: { enfant: true } },
              },
            },
          },
        },
      },
    });

    if (!personne) {
      res.status(404).json({ error: 'Personne introuvable' });
      return;
    }

    res.json(personne);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── POST /api/personnes ─────────────────────────
router.post('/', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = personneSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { id, ...data } = parse.data;

  try {
    const personne = await prisma.personne.create({
      data: {
        ...(id ? { id } : {}), // conserve l'UUID local si fourni
        familleId: req.user!.familleId,
        ...data,
      },
    });

    res.status(201).json(personne);
  } catch (err: unknown) {
    // Conflit d'ID unique (même UUID déjà en base)
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Une personne avec cet ID existe déjà' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// ── PUT /api/personnes/:id ──────────────────────
router.put('/:id', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = personneSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  try {
    const existing = await prisma.personne.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Personne introuvable' });
      return;
    }

    const { id: _id, ...data } = parse.data;
    const personne = await prisma.personne.update({
      where: { id: req.params.id },
      data,
    });

    res.json(personne);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

// ── DELETE /api/personnes/:id ───────────────────
router.delete('/:id', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const existing = await prisma.personne.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Personne introuvable' });
      return;
    }

    await prisma.personne.delete({ where: { id: req.params.id } });
    res.json({ message: 'Personne supprimée' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// ── GET /api/personnes/search?q= ────────────────
router.get('/search', async (req: AuthRequest, res: Response): Promise<void> => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.status(400).json({ error: 'Paramètre q requis' });
    return;
  }

  try {
    const personnes = await prisma.personne.findMany({
      where: {
        familleId: req.user!.familleId,
        OR: [
          { nomNaissance: { contains: q, mode: 'insensitive' } },
          { nomUsage: { contains: q, mode: 'insensitive' } },
          { prenoms: { contains: q, mode: 'insensitive' } },
          { lieuNaissance: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 30,
    });

    res.json(personnes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

export default router;
