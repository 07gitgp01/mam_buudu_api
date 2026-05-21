import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { generateToken, generateViewonlyToken, requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes.' },
});

// ── Utilitaires ─────────────────────────────────────────────────────────────

function generateFamilleCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function generateUniqueCode(): Promise<string> {
  let code: string;
  let exists = true;
  do {
    code = generateFamilleCode();
    const found = await prisma.famille.findUnique({ where: { codeUnique: code } });
    exists = !!found;
  } while (exists);
  return code;
}

function generateViewonlyPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 8; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

async function generateUniqueUsername(base: string): Promise<string> {
  const clean = base.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  let username = clean || 'famille';
  let i = 1;
  while (await prisma.user.findUnique({ where: { username } }) ||
         await prisma.famille.findUnique({ where: { viewonlyUsername: username } })) {
    username = `${clean}${i++}`;
  }
  return username;
}

// ── Schémas Zod ─────────────────────────────────────────────────────────────

const registerSchema = z.object({
  nomFamille: z.string().min(1, 'Nom de famille requis'),
  codeUnique: z.string().min(4).max(12).regex(/^[A-Z0-9]+$/, 'Code invalide').optional(),
  lieu: z.string().optional(),
  email: z.string().email('Email invalide'),
  telephone: z.string().optional(),
  password: z.string().min(8, 'Minimum 8 caractères'),
  nom: z.string().min(1, 'Nom requis'),
  prenom: z.string().min(1, 'Prénom requis'),
  questionSecrete: z.string().min(1, 'Question secrète requise'),
  reponseSecrete: z.string().min(1, 'Réponse secrète requise'),
});

const loginEmailSchema = z.object({
  familleCode: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
});

const loginPhoneSchema = z.object({
  familleCode: z.string().min(1),
  telephone: z.string().min(1),
  password: z.string().min(1),
});

const loginUsernameSchema = z.object({
  familleCode: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

const loginViewonlySchema = z.object({
  familleCode: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

// Schéma legacy (email ou tel dans le même champ) — conservé pour compatibilité
const loginLegacySchema = z.object({
  familleCode: z.string().min(1),
  identifiant: z.string().min(1),
  password: z.string().min(1),
});

const resetSchema = z.object({
  email: z.string().email(),
  questionSecrete: z.string().min(1),
  reponseSecrete: z.string().min(1),
  newPassword: z.string().min(8),
});

const createMembreSchema = z.object({
  telephone: z.string().min(1, 'Numéro de téléphone requis'),
  email: z.string().email('Email invalide').optional(),
  password: z.string().min(8, 'Minimum 8 caractères'),
  nom: z.string().min(1, 'Nom requis'),
  prenom: z.string().min(1, 'Prénom requis'),
  role: z.enum(['gestionnaire', 'membre']).default('membre'),
  personneId: z.string().uuid().optional(),
});

const completeProfileSchema = z.object({
  questionSecrete: z.string().min(1, 'Question secrète requise'),
  reponseSecrete: z.string().min(1, 'Réponse secrète requise'),
  telephone: z.string().optional(),
  email: z.string().email().optional(),
});

// ── POST /api/auth/register ─────────────────────────────────────────────────

router.post('/register', authLimit, async (req: Request, res: Response): Promise<void> => {
  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { email, telephone, password, nom, prenom, questionSecrete, reponseSecrete, nomFamille, codeUnique, lieu } = parse.data;

  try {
    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      res.status(409).json({ error: 'Cet email est déjà utilisé' });
      return;
    }

    if (telephone) {
      const existingTel = await prisma.user.findUnique({ where: { telephone } });
      if (existingTel) {
        res.status(409).json({ error: 'Ce numéro de téléphone est déjà utilisé' });
        return;
      }
    }

    let finalCode = codeUnique;
    if (finalCode) {
      const existingCode = await prisma.famille.findUnique({ where: { codeUnique: finalCode } });
      if (existingCode) {
        res.status(409).json({ error: 'Ce code de famille est déjà utilisé' });
        return;
      }
    } else {
      finalCode = await generateUniqueCode();
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const reponseHash = await bcrypt.hash(reponseSecrete.toLowerCase().trim(), 12);

    // Générer les accès viewonly
    const viewonlyUsername = await generateUniqueUsername(nomFamille);
    const viewonlyPassword = generateViewonlyPassword();
    const viewonlyPasswordHash = await bcrypt.hash(viewonlyPassword, 10);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, telephone, passwordHash, nom, prenom, questionSecrete, reponseHash },
      });

      const famille = await tx.famille.create({
        data: {
          nom: nomFamille, codeUnique: finalCode!, lieu,
          viewonlyUsername, viewonlyPassword, viewonlyPasswordHash,
        },
      });

      await tx.familleMembre.create({
        data: { userId: user.id, familleId: famille.id, role: 'admin' },
      });

      return { user, famille };
    });

    const token = generateToken(result.user.id, result.user.email, result.famille.id);

    res.status(201).json({
      token,
      user: {
        id: result.user.id, email: result.user.email,
        telephone: result.user.telephone, nom: result.user.nom,
        prenom: result.user.prenom, role: 'admin',
        hasCompletedProfile: true,
      },
      famille: {
        id: result.famille.id, nom: result.famille.nom,
        codeUnique: result.famille.codeUnique,
        viewonlyUsername: result.famille.viewonlyUsername,
        viewonlyPassword: result.famille.viewonlyPassword,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création du compte' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
// Supporte : email, telephone, username (+ viewonly via username)

router.post('/login', authLimit, async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, string>;

  try {
    // Déterminer le mode de connexion
    let user: Awaited<ReturnType<typeof prisma.user.findUnique>> | null = null;
    let familleId: string | null = null;
    let role: string | null = null;
    let isViewonly = false;

    const { familleCode, password } = body;
    if (!familleCode || !password) {
      res.status(400).json({ error: 'Code famille et mot de passe requis' });
      return;
    }

    const famille = await prisma.famille.findUnique({ where: { codeUnique: familleCode.toUpperCase() } });
    if (!famille) {
      res.status(401).json({ error: 'Code de famille incorrect' });
      return;
    }

    // Tentative login viewonly
    if (body.username && famille.viewonlyUsername === body.username) {
      if (famille.viewonlyPasswordHash && await bcrypt.compare(password, famille.viewonlyPasswordHash)) {
        const token = generateViewonlyToken(famille.id);
        res.json({
          token,
          isViewonly: true,
          user: { id: 'viewonly', nom: famille.nom, prenom: 'Accès', role: 'viewonly', hasCompletedProfile: true },
          famille: { id: famille.id, nom: famille.nom, codeUnique: famille.codeUnique },
        });
        return;
      }
    }

    // Login par email
    if (body.email) {
      user = await prisma.user.findUnique({ where: { email: body.email } });
    }
    // Login par téléphone
    else if (body.telephone) {
      user = await prisma.user.findUnique({ where: { telephone: body.telephone } });
    }
    // Login par username
    else if (body.username) {
      user = await prisma.user.findUnique({ where: { username: body.username } });
    }
    // Legacy: identifiant (email ou tel)
    else if (body.identifiant) {
      const isEmail = body.identifiant.includes('@');
      user = isEmail
        ? await prisma.user.findUnique({ where: { email: body.identifiant } })
        : await prisma.user.findUnique({ where: { telephone: body.identifiant } });
    }

    if (!user) {
      res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
      return;
    }

    const membre = await prisma.familleMembre.findUnique({
      where: { familleId_userId: { familleId: famille.id, userId: user.id } },
    });
    if (!membre) {
      res.status(403).json({ error: "Vous n'êtes pas membre de cette famille" });
      return;
    }

    const token = generateToken(user.id, user.email, famille.id);
    const hasCompletedProfile = !!user.questionSecrete;

    res.json({
      token,
      user: {
        id: user.id, email: user.email, telephone: user.telephone,
        nom: user.nom, prenom: user.prenom, role: membre.role,
        hasCompletedProfile,
      },
      famille: { id: famille.id, nom: famille.nom, codeUnique: famille.codeUnique },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────────

router.post('/reset-password', authLimit, async (req: Request, res: Response): Promise<void> => {
  const parse = resetSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { email, questionSecrete, reponseSecrete, newPassword } = parse.data;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(200).json({ message: 'Si ce compte existe, le mot de passe a été réinitialisé.' });
      return;
    }

    if (user.questionSecrete !== questionSecrete) {
      res.status(400).json({ error: 'Question secrète incorrecte' });
      return;
    }

    if (!user.reponseHash || !await bcrypt.compare(reponseSecrete.toLowerCase().trim(), user.reponseHash)) {
      res.status(400).json({ error: 'Réponse secrète incorrecte' });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    res.json({ message: 'Mot de passe mis à jour avec succès' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la réinitialisation' });
  }
});

// ── POST /api/auth/membres/create ─────────────────────────────────────────────

router.post('/membres/create', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.isViewonly) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }

  const demandeur = await prisma.familleMembre.findUnique({
    where: { familleId_userId: { familleId: req.user!.familleId, userId: req.user!.id } },
  });
  if (!demandeur || (demandeur.role !== 'admin' && demandeur.role !== 'gestionnaire')) {
    res.status(403).json({ error: 'Seuls les administrateurs et gestionnaires peuvent créer des membres' });
    return;
  }

  const parse = createMembreSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { telephone, email, password, nom, prenom, role, personneId } = parse.data;

  try {
    const existingTel = await prisma.user.findUnique({ where: { telephone } });
    if (existingTel) {
      res.status(409).json({ error: 'Ce numéro de téléphone est déjà utilisé' });
      return;
    }

    if (email) {
      const existingEmail = await prisma.user.findUnique({ where: { email } });
      if (existingEmail) {
        res.status(409).json({ error: 'Cet email est déjà utilisé' });
        return;
      }
    }

    if (personneId) {
      const personne = await prisma.personne.findFirst({
        where: { id: personneId, familleId: req.user!.familleId },
        include: { familleMembre: true },
      });
      if (!personne) {
        res.status(404).json({ error: 'Personne introuvable dans cette famille' });
        return;
      }
      if (personne.familleMembre) {
        res.status(409).json({ error: 'Cette personne a déjà un compte' });
        return;
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { telephone, email: email || null, passwordHash, nom, prenom },
      });
      await tx.familleMembre.create({
        data: { userId: user.id, familleId: req.user!.familleId, role, ...(personneId ? { personneId } : {}) },
      });
      return user;
    });

    res.status(201).json({
      message: `${prenom} ${nom} a été ajouté(e) comme ${role}`,
      membre: { id: result.id, email: result.email, telephone: result.telephone, nom: result.nom, prenom: result.prenom, role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création du membre' });
  }
});

// ── POST /api/auth/complete-profile ──────────────────────────────────────────
// Le nouveau membre complète sa question secrète et réponse à la première connexion

router.post('/complete-profile', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.isViewonly) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }

  const parse = completeProfileSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { questionSecrete, reponseSecrete, telephone, email } = parse.data;

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) {
      res.status(404).json({ error: 'Utilisateur introuvable' });
      return;
    }

    if (user.questionSecrete) {
      res.status(400).json({ error: 'Profil déjà complété' });
      return;
    }

    const updates: Record<string, string | null> = {
      questionSecrete,
      reponseHash: await bcrypt.hash(reponseSecrete.toLowerCase().trim(), 12),
    };

    if (telephone && !user.telephone) {
      const existingTel = await prisma.user.findUnique({ where: { telephone } });
      if (existingTel) {
        res.status(409).json({ error: 'Ce numéro est déjà utilisé' });
        return;
      }
      updates.telephone = telephone;
    }

    if (email && !user.email) {
      const existingEmail = await prisma.user.findUnique({ where: { email } });
      if (existingEmail) {
        res.status(409).json({ error: 'Cet email est déjà utilisé' });
        return;
      }
      updates.email = email;
    }

    await prisma.user.update({ where: { id: req.user!.id }, data: updates });

    res.json({ message: 'Profil complété avec succès' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du profil' });
  }
});

// ── GET /api/auth/viewonly-credentials ───────────────────────────────────────
// Retourne les accès viewonly de la famille (admin uniquement)

router.get('/viewonly-credentials', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.isViewonly) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }

  try {
    let famille = await prisma.famille.findUnique({
      where: { id: req.user!.familleId },
      select: { nom: true, viewonlyUsername: true, viewonlyPassword: true, viewonlyPasswordHash: true, codeUnique: true },
    });

    if (!famille) {
      res.status(404).json({ error: 'Famille introuvable' });
      return;
    }

    // Génération à la volée pour les familles existantes sans credentials viewonly
    if (!famille.viewonlyUsername || !famille.viewonlyPassword) {
      const viewonlyUsername = await generateUniqueUsername(famille.nom);
      const viewonlyPassword = generateViewonlyPassword();
      const viewonlyPasswordHash = await bcrypt.hash(viewonlyPassword, 10);

      await prisma.famille.update({
        where: { id: req.user!.familleId },
        data: { viewonlyUsername, viewonlyPassword, viewonlyPasswordHash },
      });

      famille = { ...famille, viewonlyUsername, viewonlyPassword, viewonlyPasswordHash };
    }

    res.json({
      viewonlyUsername: famille.viewonlyUsername,
      viewonlyPassword: famille.viewonlyPassword,
      familleCode: famille.codeUnique,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.isViewonly) {
    res.json({ isViewonly: true });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, email: true, telephone: true, nom: true, prenom: true, createdAt: true },
    });

    const familles = await prisma.familleMembre.findMany({
      where: { userId: req.user!.id },
      include: { famille: { select: { id: true, nom: true, codeUnique: true, lieu: true } } },
    });

    res.json({
      user,
      familles: familles.map(m => ({ ...m.famille, role: m.role })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

export default router;
