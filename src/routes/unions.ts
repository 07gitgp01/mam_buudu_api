import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

// ── Schémas ─────────────────────────────────────
const unionSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.string().optional().nullable(),
  dateDebut: z.string().optional().nullable(),
  lieuDebut: z.string().optional().nullable(),
  dateFin: z.string().optional().nullable(),
  lieuFin: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  // Participants (couple) : tableau de personneId
  parentIds: z.array(z.string().uuid()).max(2).optional(),
  // Enfants : tableau de { enfantId, ordreNaissance }
  enfantIds: z.array(z.string().uuid()).optional(),
});

const filiationSchema = z.object({
  enfantId: z.string().uuid(),
  ordreNaissance: z.number().int().min(0).optional(),
});

// Helper : vérifie que les personnes appartiennent à la famille
async function checkPersonnesFamille(personneIds: string[], familleId: string): Promise<boolean> {
  const count = await prisma.personne.count({
    where: { id: { in: personneIds }, familleId },
  });
  return count === personneIds.length;
}

// ── GET /api/unions ─────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const unions = await prisma.union.findMany({
      where: { familleId: req.user!.familleId },
      include: {
        participants: { include: { personne: true }, orderBy: { ordre: 'asc' } },
        filiations: { include: { enfant: true }, orderBy: { ordreNaissance: 'asc' } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(unions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── GET /api/unions/:id ─────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const union = await prisma.union.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
      include: {
        participants: { include: { personne: true }, orderBy: { ordre: 'asc' } },
        filiations: { include: { enfant: true }, orderBy: { ordreNaissance: 'asc' } },
      },
    });

    if (!union) {
      res.status(404).json({ error: 'Union introuvable' });
      return;
    }

    res.json(union);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── POST /api/unions ────────────────────────────
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = unionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { id, parentIds = [], enfantIds = [], ...data } = parse.data;

  try {
    // Vérifie que toutes les personnes appartiennent à la famille
    const allIds = [...parentIds, ...enfantIds];
    if (allIds.length > 0) {
      const ok = await checkPersonnesFamille(allIds, req.user!.familleId);
      if (!ok) {
        res.status(403).json({ error: 'Certaines personnes n\'appartiennent pas à cette famille' });
        return;
      }
    }

    const union = await prisma.$transaction(async (tx) => {
      const u = await tx.union.create({
        data: {
          ...(id ? { id } : {}),
          familleId: req.user!.familleId,
          ...data,
          // Participants (couple)
          participants: {
            create: parentIds.map((pid, i) => ({
              personneId: pid,
              role: 'conjoint',
              ordre: i,
            })),
          },
          // Filiations (enfants)
          filiations: {
            create: enfantIds.map((eid, i) => ({
              enfantId: eid,
              ordreNaissance: i,
            })),
          },
        },
        include: {
          participants: { include: { personne: true } },
          filiations: { include: { enfant: true } },
        },
      });
      return u;
    });

    res.status(201).json(union);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Cette union existe déjà' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// ── PUT /api/unions/:id ─────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = unionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { id: _id, parentIds, enfantIds, ...data } = parse.data;

  try {
    const existing = await prisma.union.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Union introuvable' });
      return;
    }

    const union = await prisma.$transaction(async (tx) => {
      // Met à jour les champs de base
      const u = await tx.union.update({ where: { id: req.params.id }, data });

      // Remplace les participants si fournis
      if (parentIds !== undefined) {
        await tx.unionParticipant.deleteMany({ where: { unionId: req.params.id } });
        await tx.unionParticipant.createMany({
          data: parentIds.map((pid, i) => ({
            unionId: req.params.id,
            personneId: pid,
            role: 'conjoint',
            ordre: i,
          })),
        });
      }

      // Remplace les filiations si fournies
      if (enfantIds !== undefined) {
        await tx.filiation.deleteMany({ where: { unionId: req.params.id } });
        await tx.filiation.createMany({
          data: enfantIds.map((eid, i) => ({
            unionId: req.params.id,
            enfantId: eid,
            ordreNaissance: i,
          })),
        });
      }

      return u;
    });

    // Retourne l'union complète
    const full = await prisma.union.findUnique({
      where: { id: union.id },
      include: {
        participants: { include: { personne: true } },
        filiations: { include: { enfant: true } },
      },
    });

    res.json(full);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

// ── DELETE /api/unions/:id ──────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const existing = await prisma.union.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Union introuvable' });
      return;
    }

    await prisma.union.delete({ where: { id: req.params.id } });
    res.json({ message: 'Union supprimée' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// ── POST /api/unions/:id/enfants ─────────────────
// Ajouter un enfant à une union existante
router.post('/:id/enfants', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = filiationSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  try {
    const union = await prisma.union.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
    });
    if (!union) {
      res.status(404).json({ error: 'Union introuvable' });
      return;
    }

    const filiation = await prisma.filiation.create({
      data: {
        unionId: req.params.id,
        enfantId: parse.data.enfantId,
        ordreNaissance: parse.data.ordreNaissance ?? 0,
      },
      include: { enfant: true },
    });

    res.status(201).json(filiation);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Cet enfant est déjà lié à cette union' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── DELETE /api/unions/:id/enfants/:enfantId ─────
router.delete('/:id/enfants/:enfantId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.filiation.deleteMany({
      where: { unionId: req.params.id, enfantId: req.params.enfantId },
    });
    res.json({ message: 'Filiation supprimée' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

export default router;
