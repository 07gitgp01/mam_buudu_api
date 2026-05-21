import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────
// SYNC : stratégie "last-write-wins" par entité
//
// Le client Flutter envoie les changements locaux (push),
// puis récupère les changements distants depuis sa dernière sync (pull).
// ─────────────────────────────────────────────────

const syncItemSchema = z.object({
  entityType: z.enum(['personne', 'union', 'filiation']),
  entityId: z.string().uuid(),
  operation: z.enum(['create', 'update', 'delete']),
  payload: z.record(z.unknown()).optional(), // données complètes de l'entité
  clientUpdatedAt: z.string().datetime().optional(), // timestamp côté client
});

const pushSchema = z.object({
  items: z.array(syncItemSchema).max(500),
});

// ── POST /api/sync/push ─────────────────────────
// Le client envoie ses changements locaux
router.post('/push', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = pushSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { items } = parse.data;
  const familleId = req.user!.familleId;
  const userId = req.user!.id;
  const results: { entityId: string; status: 'ok' | 'error'; message?: string }[] = [];

  for (const item of items) {
    try {
      await processItem(item, familleId, userId);
      results.push({ entityId: item.entityId, status: 'ok' });
    } catch (err) {
      console.error(`Sync push error [${item.entityType}/${item.entityId}]:`, err);
      results.push({ entityId: item.entityId, status: 'error', message: String(err) });
    }
  }

  res.json({ synced: results.filter(r => r.status === 'ok').length, results });
});

// ── GET /api/sync/pull?since=ISO_DATE ──────────
// Le client récupère tous les changements depuis sa dernière sync
router.get('/pull', async (req: AuthRequest, res: Response): Promise<void> => {
  const sinceParam = req.query.since as string | undefined;
  const since = sinceParam ? new Date(sinceParam) : new Date(0);

  if (isNaN(since.getTime())) {
    res.status(400).json({ error: 'Paramètre "since" invalide (format ISO 8601 attendu)' });
    return;
  }

  try {
    const familleId = req.user!.familleId;

    // Récupère toutes les entités modifiées depuis la date donnée
    const [personnes, unions] = await Promise.all([
      prisma.personne.findMany({
        where: { familleId, updatedAt: { gt: since } },
      }),
      prisma.union.findMany({
        where: { familleId, updatedAt: { gt: since } },
        include: {
          participants: { orderBy: { ordre: 'asc' } },
          filiations: { orderBy: { ordreNaissance: 'asc' } },
        },
      }),
    ]);

    // Récupère les suppressions loguées
    const deletions = await prisma.syncLog.findMany({
      where: {
        familleId,
        operation: 'delete',
        syncedAt: { gt: since },
      },
      select: { entityType: true, entityId: true, syncedAt: true },
      orderBy: { syncedAt: 'asc' },
    });

    res.json({
      serverTime: new Date().toISOString(),
      personnes,
      unions: unions.map(u => ({
        ...u,
        parentIds: u.participants.map(p => p.personneId),
        enfantIds: u.filiations.map(f => f.enfantId),
      })),
      deletions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors du pull' });
  }
});

// ── Traitement d'un item de sync ─────────────────
async function processItem(
  item: z.infer<typeof syncItemSchema>,
  familleId: string,
  userId: string
): Promise<void> {
  const { entityType, entityId, operation, payload } = item;

  if (operation === 'delete') {
    // Log la suppression pour que les autres clients puissent la récupérer via pull
    await prisma.syncLog.create({
      data: { userId, familleId, entityType, entityId, operation: 'delete' },
    });

    if (entityType === 'personne') {
      await prisma.personne.deleteMany({ where: { id: entityId, familleId } });
    } else if (entityType === 'union') {
      await prisma.union.deleteMany({ where: { id: entityId, familleId } });
    } else if (entityType === 'filiation') {
      // payload doit contenir unionId
      const unionId = (payload as Record<string, string> | undefined)?.unionId;
      if (unionId) {
        await prisma.filiation.deleteMany({ where: { unionId, enfantId: entityId } });
      }
    }
    return;
  }

  if (!payload) return;

  if (entityType === 'personne') {
    const data = payload as Record<string, unknown>;
    // Sécurité : empêcher la modification d'une personne d'une autre famille
    const existingP = await prisma.personne.findUnique({ where: { id: entityId }, select: { familleId: true } });
    if (existingP && existingP.familleId !== familleId) {
      throw new Error(`Accès refusé : la personne ${entityId} appartient à une autre famille`);
    }
    await prisma.personne.upsert({
      where: { id: entityId },
      create: {
        id: entityId,
        familleId,
        nomNaissance: data.nomNaissance as string | null,
        nomUsage: data.nomUsage as string | null,
        prenoms: data.prenoms as string | null,
        sexe: data.sexe as string | null,
        dateNaissance: data.dateNaissance as string | null,
        lieuNaissance: data.lieuNaissance as string | null,
        dateDeces: data.dateDeces as string | null,
        lieuDeces: data.lieuDeces as string | null,
        biographie: data.biographie as string | null,
        notes: data.notes as string | null,
        photoUrl: data.photoUrl as string | null,
      },
      update: {
        nomNaissance: data.nomNaissance as string | null,
        nomUsage: data.nomUsage as string | null,
        prenoms: data.prenoms as string | null,
        sexe: data.sexe as string | null,
        dateNaissance: data.dateNaissance as string | null,
        lieuNaissance: data.lieuNaissance as string | null,
        dateDeces: data.dateDeces as string | null,
        lieuDeces: data.lieuDeces as string | null,
        biographie: data.biographie as string | null,
        notes: data.notes as string | null,
        photoUrl: data.photoUrl as string | null,
      },
    });
  } else if (entityType === 'union') {
    const data = payload as Record<string, unknown>;
    const parentIds = (data.parentIds as string[] | undefined) ?? [];
    const enfantIds = (data.enfantIds as string[] | undefined) ?? [];

    // Sécurité : empêcher la modification d'une union d'une autre famille
    const existingU = await prisma.union.findUnique({ where: { id: entityId }, select: { familleId: true } });
    if (existingU && existingU.familleId !== familleId) {
      throw new Error(`Accès refusé : l'union ${entityId} appartient à une autre famille`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.union.upsert({
        where: { id: entityId },
        create: {
          id: entityId,
          familleId,
          type: data.type as string | null,
          dateDebut: data.dateDebut as string | null,
          lieuDebut: data.lieuDebut as string | null,
          dateFin: data.dateFin as string | null,
          lieuFin: data.lieuFin as string | null,
          notes: data.notes as string | null,
        },
        update: {
          type: data.type as string | null,
          dateDebut: data.dateDebut as string | null,
          lieuDebut: data.lieuDebut as string | null,
          dateFin: data.dateFin as string | null,
          lieuFin: data.lieuFin as string | null,
          notes: data.notes as string | null,
        },
      });

      // Remplace participants
      await tx.unionParticipant.deleteMany({ where: { unionId: entityId } });
      if (parentIds.length > 0) {
        await tx.unionParticipant.createMany({
          data: parentIds.map((pid, i) => ({ unionId: entityId, personneId: pid, ordre: i })),
          skipDuplicates: true,
        });
      }

      // Remplace filiations
      await tx.filiation.deleteMany({ where: { unionId: entityId } });
      if (enfantIds.length > 0) {
        await tx.filiation.createMany({
          data: enfantIds.map((eid, i) => ({ unionId: entityId, enfantId: eid, ordreNaissance: i })),
          skipDuplicates: true,
        });
      }
    });
  }

  // Log l'opération
  await prisma.syncLog.create({
    data: {
      userId,
      familleId,
      entityType,
      entityId,
      operation,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

export default router;
