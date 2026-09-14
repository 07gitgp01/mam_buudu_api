import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

/**
 * @openapi
 * /api/activity:
 *   get:
 *     tags: [Activity]
 *     summary: Journal d'activité paginé de la famille (créations/modifications/suppressions)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, maximum: 100 }
 *     responses:
 *       200:
 *         description: "{ data, total, page, limit, totalPages }"
 */
// ── GET /api/activity ────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '30'), 10) || 30));

    const where = { familleId: req.user!.familleId };

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, nom: true, prenom: true } },
        },
      }),
      prisma.activityLog.count({ where }),
    ]);

    res.json({
      data: logs.map(l => ({
        id:         l.id,
        action:     l.action,
        targetType: l.targetType,
        targetId:   l.targetId,
        details:    l.details,
        createdAt:  l.createdAt.toISOString(),
        auteurNom:  l.user ? `${l.user.prenom} ${l.user.nom}` : null,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('[activity GET]', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

export default router;
