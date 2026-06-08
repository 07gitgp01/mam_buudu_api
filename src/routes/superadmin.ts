import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { requireSuperAdmin, requireRole, generateSuperAdminToken } from '../middleware/superadmin';
import { SuperAdminRequest } from '../types';

const router = Router();

// ── POST /api/superadmin/auth/login ─────────────────────────────────────────
// Login superadmin (email + password, sans code famille)
router.post('/auth/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) { res.status(400).json({ error: 'Email et mot de passe requis' }); return; }
  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.platformRole) { res.status(401).json({ error: 'Accès refusé' }); return; }
    if (user.suspended) { res.status(403).json({ error: 'Compte suspendu' }); return; }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) { res.status(401).json({ error: 'Email ou mot de passe incorrect' }); return; }
    const token = generateSuperAdminToken(user.id, user.platformRole);
    res.json({ token, user: { id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, platformRole: user.platformRole } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── GET /api/superadmin/stats ────────────────────────────────────────────────
router.get('/stats', requireSuperAdmin, async (_req: SuperAdminRequest, res: Response): Promise<void> => {
  try {
    const [totalFamilles, totalUsers, totalSubscriptions, revenueResult, newUsersWeek, newFamillesMonth] = await Promise.all([
      prisma.famille.count(),
      prisma.user.count(),
      prisma.subscription.count({ where: { statut: 'actif' } }),
      prisma.paiement.aggregate({ _sum: { montant: true }, where: { statut: 'success', createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }),
      prisma.user.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } } }),
      prisma.famille.count({ where: { createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }),
    ]);
    res.json({ totalFamilles, totalUsers, totalSubscriptions, revenueMois: revenueResult._sum.montant ?? 0, newUsersWeek, newFamillesMonth });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── GET /api/superadmin/familles ─────────────────────────────────────────────
router.get('/familles', requireSuperAdmin, async (req: SuperAdminRequest, res: Response): Promise<void> => {
  const page  = Math.max(1, parseInt(req.query['page'] as string) || 1);
  const limit = Math.min(50, parseInt(req.query['limit'] as string) || 20);
  const q     = (req.query['q'] as string) || '';
  const statut = (req.query['statut'] as string) || '';
  try {
    const where: any = {};
    if (q) where.nom = { contains: q, mode: 'insensitive' };
    if (statut) where.statut = statut;
    const [familles, total] = await Promise.all([
      prisma.famille.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { membres: true, personnes: true } },
          subscription: { include: { plan: true } },
        },
      }),
      prisma.famille.count({ where }),
    ]);
    res.json({ familles, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── GET /api/superadmin/familles/:id ─────────────────────────────────────────
router.get('/familles/:id', requireSuperAdmin, async (req: SuperAdminRequest, res: Response): Promise<void> => {
  try {
    const famille = await prisma.famille.findUnique({
      where: { id: req.params['id'] },
      include: {
        membres: { include: { user: { select: { id: true, nom: true, prenom: true, email: true, telephone: true } } } },
        subscription: { include: { plan: true } },
        _count: { select: { personnes: true, stories: true, photos: true } },
      },
    });
    if (!famille) { res.status(404).json({ error: 'Famille introuvable' }); return; }
    res.json(famille);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── PATCH /api/superadmin/familles/:id ───────────────────────────────────────
router.patch('/familles/:id', requireSuperAdmin, requireRole('superadmin', 'platform_admin'), async (req: SuperAdminRequest, res: Response): Promise<void> => {
  const { statut, nom } = req.body as { statut?: string; nom?: string };
  try {
    const data: any = {};
    if (statut && ['actif', 'suspendu'].includes(statut)) data.statut = statut;
    if (nom) data.nom = nom;
    const famille = await prisma.famille.update({ where: { id: req.params['id'] }, data });
    res.json(famille);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── DELETE /api/superadmin/familles/:id ──────────────────────────────────────
router.delete('/familles/:id', requireSuperAdmin, requireRole('superadmin'), async (req: SuperAdminRequest, res: Response): Promise<void> => {
  try {
    await prisma.famille.delete({ where: { id: req.params['id'] } });
    res.json({ message: 'Famille supprimée' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── GET /api/superadmin/users ─────────────────────────────────────────────────
router.get('/users', requireSuperAdmin, async (req: SuperAdminRequest, res: Response): Promise<void> => {
  const page  = Math.max(1, parseInt(req.query['page'] as string) || 1);
  const limit = Math.min(50, parseInt(req.query['limit'] as string) || 20);
  const q     = (req.query['q'] as string) || '';
  const platformRole = (req.query['platformRole'] as string) || '';
  try {
    const where: any = {};
    if (q) where.OR = [
      { email: { contains: q, mode: 'insensitive' } },
      { nom: { contains: q, mode: 'insensitive' } },
      { prenom: { contains: q, mode: 'insensitive' } },
      { telephone: { contains: q } },
    ];
    if (platformRole === 'none') where.platformRole = null;
    else if (platformRole) where.platformRole = platformRole;
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, email: true, telephone: true, nom: true, prenom: true,
          platformRole: true, suspended: true, emailVerified: true, createdAt: true,
          _count: { select: { familleMembres: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── PATCH /api/superadmin/users/:id ──────────────────────────────────────────
router.patch('/users/:id', requireSuperAdmin, requireRole('superadmin'), async (req: SuperAdminRequest, res: Response): Promise<void> => {
  const { platformRole, suspended } = req.body as { platformRole?: string | null; suspended?: boolean };
  if (req.params['id'] === req.superadmin?.id) { res.status(400).json({ error: 'Vous ne pouvez pas modifier votre propre rôle' }); return; }
  try {
    const data: any = {};
    if (platformRole !== undefined) data.platformRole = platformRole || null;
    if (suspended !== undefined) data.suspended = suspended;
    const user = await prisma.user.update({
      where: { id: req.params['id'] },
      data,
      select: { id: true, email: true, nom: true, prenom: true, platformRole: true, suspended: true },
    });
    res.json(user);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── DELETE /api/superadmin/users/:id ─────────────────────────────────────────
router.delete('/users/:id', requireSuperAdmin, requireRole('superadmin'), async (req: SuperAdminRequest, res: Response): Promise<void> => {
  if (req.params['id'] === req.superadmin?.id) { res.status(400).json({ error: 'Vous ne pouvez pas vous supprimer' }); return; }
  try {
    await prisma.user.delete({ where: { id: req.params['id'] } });
    res.json({ message: 'Utilisateur supprimé' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── GET /api/superadmin/subscriptions ────────────────────────────────────────
router.get('/subscriptions', requireSuperAdmin, async (req: SuperAdminRequest, res: Response): Promise<void> => {
  const page  = Math.max(1, parseInt(req.query['page'] as string) || 1);
  const limit = Math.min(50, parseInt(req.query['limit'] as string) || 20);
  const statut = (req.query['statut'] as string) || '';
  try {
    const where: any = {};
    if (statut) where.statut = statut;
    const [subs, total] = await Promise.all([
      prisma.subscription.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          plan: true,
          famille: { select: { id: true, nom: true, codeUnique: true } },
          paiements: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      prisma.subscription.count({ where }),
    ]);
    res.json({ subscriptions: subs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── GET /api/superadmin/plans ─────────────────────────────────────────────────
router.get('/plans', requireSuperAdmin, async (_req, res) => {
  try {
    const plans = await prisma.plan.findMany({ include: { _count: { select: { subscriptions: true } } } });
    res.json(plans);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── POST /api/superadmin/plans ────────────────────────────────────────────────
router.post('/plans', requireSuperAdmin, requireRole('superadmin'), async (req: SuperAdminRequest, res: Response): Promise<void> => {
  const { id, nom, label, prix, maxPersonnes, features } = req.body;
  try {
    const plan = await prisma.plan.create({ data: { id, nom, label, prix, maxPersonnes: maxPersonnes ?? null, features: features ?? [] } });
    res.status(201).json(plan);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── PATCH /api/superadmin/plans/:id ──────────────────────────────────────────
router.patch('/plans/:id', requireSuperAdmin, requireRole('superadmin'), async (req: SuperAdminRequest, res: Response): Promise<void> => {
  const { label, prix, maxPersonnes, features } = req.body;
  try {
    const data: any = {};
    if (label !== undefined) data.label = label;
    if (prix !== undefined) data.prix = prix;
    if (maxPersonnes !== undefined) data.maxPersonnes = maxPersonnes ?? null;
    if (features !== undefined) data.features = features;
    const plan = await prisma.plan.update({ where: { id: req.params['id'] }, data });
    res.json(plan);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── GET /api/superadmin/settings ─────────────────────────────────────────────
router.get('/settings', requireSuperAdmin, async (_req, res) => {
  try {
    const settings = await prisma.platformSetting.findMany({ orderBy: { key: 'asc' } });
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── PATCH /api/superadmin/settings/:key ──────────────────────────────────────
router.patch('/settings/:key', requireSuperAdmin, requireRole('superadmin'), async (req: SuperAdminRequest, res: Response): Promise<void> => {
  const { value, label } = req.body as { value: string; label?: string };
  if (value === undefined) { res.status(400).json({ error: 'Valeur requise' }); return; }
  try {
    const setting = await prisma.platformSetting.upsert({
      where: { key: req.params['key'] },
      create: { key: req.params['key'], value, label, updatedBy: req.superadmin?.id },
      update: { value, ...(label !== undefined ? { label } : {}), updatedBy: req.superadmin?.id },
    });
    res.json(setting);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── DELETE /api/superadmin/settings/:key ─────────────────────────────────────
router.delete('/settings/:key', requireSuperAdmin, requireRole('superadmin'), async (req: SuperAdminRequest, res: Response): Promise<void> => {
  try {
    await prisma.platformSetting.delete({ where: { key: req.params['key'] } });
    res.json({ message: 'Paramètre supprimé' });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

export default router;
