import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireManage } from '../middleware/auth';
import { AuthRequest } from '../types';
import { checkPersonneQuota } from '../lib/quota';
import { notifyFamille } from '../lib/notifications';
import { logActivity } from '../lib/activityLog';
import { redactPersonne } from '../lib/personneVisibility';

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
  visibilite: z.enum(['famille', 'prive']).optional(),
});


/**
 * @openapi
 * /api/personnes:
 *   get:
 *     tags: [Personnes]
 *     summary: Liste toutes les personnes de la famille de l'utilisateur connecté
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Liste des personnes
 *       500:
 *         description: Erreur serveur
 */
// ── GET /api/personnes ──────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const personnes = await prisma.personne.findMany({
      where: { familleId: req.user!.familleId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(personnes.map(p => redactPersonne(p, req)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

/**
 * @openapi
 * /api/personnes/{id}:
 *   get:
 *     tags: [Personnes]
 *     summary: Détail d'une personne (avec unions et filiations)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Personne trouvée }
 *       404: { description: Personne introuvable }
 */
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

    // Redaction du détail + des personnes imbriquées (conjoints/enfants) référencées
    // via les unions de cette personne.
    const shaped = {
      ...redactPersonne(personne, req),
      unionParticipants: personne.unionParticipants.map(up => ({
        ...up,
        union: {
          ...up.union,
          participants: up.union.participants.map(p => ({ ...p, personne: redactPersonne(p.personne, req) })),
          filiations: up.union.filiations.map(f => ({ ...f, enfant: redactPersonne(f.enfant, req) })),
        },
      })),
    };

    res.json(shaped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

/**
 * @openapi
 * /api/personnes:
 *   post:
 *     tags: [Personnes]
 *     summary: Crée une nouvelle personne dans l'arbre (admin/gestionnaire uniquement)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               prenoms: { type: string }
 *               nomNaissance: { type: string }
 *               sexe: { type: string, enum: [M, F, autre] }
 *               dateNaissance: { type: string, description: "YYYY, YYYY-MM ou YYYY-MM-DD" }
 *     responses:
 *       201: { description: Personne créée }
 *       400: { description: Données invalides }
 *       403: { description: "Limite du plan atteinte ou accès refusé" }
 */
// ── POST /api/personnes ─────────────────────────
router.post('/', requireManage, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = personneSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { id, ...data } = parse.data;

  try {
    // Vérification quota
    const quota = await checkPersonneQuota(req.user!.familleId);
    if (!quota.allowed) {
      res.status(403).json({
        error: `Limite de votre plan atteinte (${quota.limit} membres). Passez à un plan supérieur pour continuer.`,
        code: 'QUOTA_EXCEEDED',
        limit: quota.limit,
        current: quota.current,
      });
      return;
    }

    const personne = await prisma.personne.create({
      data: {
        ...(id ? { id } : {}), // conserve l'UUID local si fourni
        familleId: req.user!.familleId,
        ...data,
      },
    });

    res.status(201).json(personne);

    // Notifier tous les membres de la famille
    const nomComplet = [personne.prenoms, personne.nomNaissance].filter(Boolean).join(' ') || 'Inconnu';
    logActivity({
      familleId: req.user!.familleId,
      userId:    req.user!.id,
      action:    'create_personne',
      targetType: 'personne',
      targetId:  personne.id,
      details:   { nom: nomComplet },
    });
    notifyFamille(req.user!.familleId, null, {
      type:    'nouveau_membre_arbre',
      titre:   `${nomComplet} ajouté à l'arbre`,
      message: personne.dateNaissance
        ? `Né(e) le ${personne.dateNaissance}${personne.lieuNaissance ? ` à ${personne.lieuNaissance}` : ''}`
        : 'Nouveau membre dans l\'arbre généalogique',
      data:    { personneId: personne.id, nom: nomComplet, photoUrl: personne.photoUrl ?? null },
    });
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

/**
 * @openapi
 * /api/personnes/{id}:
 *   put:
 *     tags: [Personnes]
 *     summary: Met à jour une personne (admin/gestionnaire uniquement)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Personne mise à jour }
 *       404: { description: Personne introuvable }
 */
// ── PUT /api/personnes/:id ──────────────────────
router.put('/:id', requireManage, async (req: AuthRequest, res: Response): Promise<void> => {
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

    const nomComplet = [personne.prenoms, personne.nomNaissance].filter(Boolean).join(' ') || 'Inconnu';
    logActivity({
      familleId: req.user!.familleId,
      userId:    req.user!.id,
      action:    'update_personne',
      targetType: 'personne',
      targetId:  personne.id,
      details:   { nom: nomComplet },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

/**
 * @openapi
 * /api/personnes/{id}:
 *   delete:
 *     tags: [Personnes]
 *     summary: Supprime une personne (admin/gestionnaire uniquement)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Personne supprimée }
 *       404: { description: Personne introuvable }
 */
// ── DELETE /api/personnes/:id ───────────────────
router.delete('/:id', requireManage, async (req: AuthRequest, res: Response): Promise<void> => {
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

    const nomComplet = [existing.prenoms, existing.nomNaissance].filter(Boolean).join(' ') || 'Inconnu';
    logActivity({
      familleId: req.user!.familleId,
      userId:    req.user!.id,
      action:    'delete_personne',
      targetType: 'personne',
      targetId:  existing.id,
      details:   { nom: nomComplet },
    });
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
