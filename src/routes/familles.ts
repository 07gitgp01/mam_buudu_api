import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

// ── GET /api/familles/search?q= ─────────────────────────────────────────────
// Recherche publique par nom (pour l'écran de connexion — pas besoin d'être auth)
router.get('/search', async (req: Request, res: Response): Promise<void> => {
  const q = (req.query['q'] as string ?? '').trim();
  if (q.length < 1) {
    res.json([]);
    return;
  }
  try {
    const familles = await prisma.famille.findMany({
      where: { nom: { contains: q, mode: 'insensitive' } },
      select: { id: true, nom: true, lieu: true, codeUnique: true },
      take: 10,
      orderBy: { nom: 'asc' },
    });
    // Ne pas exposer codeUnique dans la recherche publique — juste id/nom/lieu
    res.json(familles.map(f => ({ id: f.id, nom: f.nom, lieu: f.lieu })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});

// ── GET /api/familles/by-code/:code ──────────────────────────────────────────
// Vérifie qu'un code existe et retourne les infos basiques (pas besoin d'auth)
router.get('/by-code/:code', async (req: Request, res: Response): Promise<void> => {
  const code = (req.params['code'] ?? '').toUpperCase().trim();
  try {
    const famille = await prisma.famille.findUnique({
      where: { codeUnique: code },
      select: { id: true, nom: true, lieu: true },
    });
    if (!famille) {
      res.status(404).json({ error: 'Aucune famille trouvée avec ce code' });
      return;
    }
    res.json(famille);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── Endpoints suivants nécessitent auth ──────────────────────────────────────
router.use(requireAuth);

// ── GET /api/familles/current ───────────────────
// Infos de la famille active avec la liste de ses membres
router.get('/current', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const famille = await prisma.famille.findUnique({
      where: { id: req.user!.familleId },
      include: {
        membres: {
          select: {
            id: true, role: true, joinedAt: true, personneId: true,
            user: { select: { id: true, nom: true, prenom: true, email: true, telephone: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });

    if (!famille) {
      res.status(404).json({ error: 'Famille introuvable' });
      return;
    }

    res.json(famille);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── PATCH /api/familles/membres/:userId/role ────
// Changer le rôle d'un membre (admin ou gestionnaire seulement)
// Un admin peut passer un membre en gestionnaire et vice-versa.
// Le rôle 'admin' ne peut pas être attribué ni retiré ici.
const changeRoleSchema = z.object({
  role: z.enum(['gestionnaire', 'membre']),
});

router.patch('/membres/:userId/role', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = changeRoleSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Rôle invalide. Valeurs acceptées : gestionnaire, membre' });
    return;
  }

  const { userId } = req.params;
  const { role } = parse.data;
  const familleId = req.user!.familleId;

  try {
    // Vérifier que le demandeur est admin ou gestionnaire
    const demandeur = await prisma.familleMembre.findUnique({
      where: { familleId_userId: { familleId, userId: req.user!.id } },
    });
    if (!demandeur || (demandeur.role !== 'admin' && demandeur.role !== 'gestionnaire')) {
      res.status(403).json({ error: 'Droits insuffisants' });
      return;
    }

    // Vérifier que la cible est dans la même famille
    const cible = await prisma.familleMembre.findUnique({
      where: { familleId_userId: { familleId, userId } },
    });
    if (!cible) {
      res.status(404).json({ error: 'Membre introuvable dans cette famille' });
      return;
    }

    // Empêcher de modifier le rôle d'un admin ou de sa propre entrée
    if (cible.role === 'admin') {
      res.status(403).json({ error: 'Impossible de modifier le rôle de l\'administrateur' });
      return;
    }
    if (userId === req.user!.id) {
      res.status(403).json({ error: 'Impossible de modifier votre propre rôle' });
      return;
    }

    const updated = await prisma.familleMembre.update({
      where: { familleId_userId: { familleId, userId } },
      data: { role },
      include: { user: { select: { nom: true, prenom: true } } },
    });

    res.json({
      message: `${updated.user.prenom} ${updated.user.nom} est maintenant ${role}`,
      userId,
      role,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors du changement de rôle' });
  }
});

// ── POST /api/familles/invite ───────────────────
// Inviter un utilisateur existant dans la famille
const inviteSchema = z.object({ email: z.string().email() });

router.post('/invite', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = inviteSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Email invalide' });
    return;
  }

  try {
    // Vérifie que l'invitant est admin
    const membre = await prisma.familleMembre.findUnique({
      where: { familleId_userId: { familleId: req.user!.familleId, userId: req.user!.id } },
    });
    if (!membre || membre.role !== 'admin') {
      res.status(403).json({ error: 'Seul un administrateur peut inviter des membres' });
      return;
    }

    const cible = await prisma.user.findUnique({ where: { email: parse.data.email } });
    if (!cible) {
      res.status(404).json({ error: 'Utilisateur introuvable' });
      return;
    }

    await prisma.familleMembre.upsert({
      where: { familleId_userId: { familleId: req.user!.familleId, userId: cible.id } },
      create: { familleId: req.user!.familleId, userId: cible.id, role: 'membre' },
      update: {},
    });

    res.json({ message: `${cible.prenom} ${cible.nom} ajouté(e) à la famille` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de l\'invitation' });
  }
});

export default router;
