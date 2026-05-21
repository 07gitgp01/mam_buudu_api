import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../types';

interface JwtPayload {
  userId: string;
  email: string | null;
  familleId: string;
  isViewonly?: boolean;
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token manquant ou invalide' });
    return;
  }

  const token = header.substring(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    if (decoded.isViewonly) {
      // Token viewonly : vérifier que la famille existe encore
      const famille = await prisma.famille.findUnique({ where: { id: decoded.familleId } });
      if (!famille) {
        res.status(401).json({ error: 'Famille introuvable' });
        return;
      }
      req.user = { id: 'viewonly', email: null, familleId: decoded.familleId, isViewonly: true };
      next();
      return;
    }

    // Token normal : vérifier que l'utilisateur existe et appartient à la famille
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) {
      res.status(401).json({ error: 'Utilisateur introuvable' });
      return;
    }

    const membre = await prisma.familleMembre.findUnique({
      where: { familleId_userId: { familleId: decoded.familleId, userId: decoded.userId } },
    });
    if (!membre) {
      res.status(403).json({ error: 'Accès à cette famille refusé' });
      return;
    }

    req.user = { id: decoded.userId, email: decoded.email, familleId: decoded.familleId };
    next();
  } catch {
    res.status(401).json({ error: 'Token expiré ou invalide' });
  }
}

export function requireEdit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.user?.isViewonly) {
    res.status(403).json({ error: 'Accès en lecture seule. Connectez-vous avec un compte personnel pour modifier les données.' });
    return;
  }
  next();
}

export function generateToken(userId: string, email: string | null, familleId: string): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN || '30d') as unknown as number;
  return jwt.sign({ userId, email, familleId }, process.env.JWT_SECRET!, { expiresIn });
}

export function generateViewonlyToken(familleId: string): string {
  // 365 days in seconds
  return jwt.sign(
    { userId: 'viewonly', email: null, familleId, isViewonly: true },
    process.env.JWT_SECRET!,
    { expiresIn: 365 * 24 * 3600 }
  );
}
