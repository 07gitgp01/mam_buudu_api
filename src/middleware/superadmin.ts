import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { SuperAdminRequest } from '../types';

interface SaJwt { userId: string; platformRole: string; isSuperAdmin: true; }

export async function requireSuperAdmin(req: SuperAdminRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Token manquant' }); return; }
  try {
    const decoded = jwt.verify(header.substring(7), process.env.JWT_SECRET!) as SaJwt;
    if (!decoded.isSuperAdmin) { res.status(403).json({ error: 'Accès superadmin requis' }); return; }
    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { id: true, platformRole: true, suspended: true } });
    if (!user?.platformRole) { res.status(403).json({ error: 'Droits insuffisants' }); return; }
    req.superadmin = { id: user.id, platformRole: user.platformRole };
    next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
}

// Middleware de vérification des rôles (à utiliser après requireSuperAdmin)
export function requireRole(...roles: string[]) {
  return (req: SuperAdminRequest, res: Response, next: NextFunction): void => {
    if (!roles.includes(req.superadmin?.platformRole ?? '')) {
      res.status(403).json({ error: 'Permissions insuffisantes pour cette action' });
      return;
    }
    next();
  };
}

export function generateSuperAdminToken(userId: string, platformRole: string): string {
  return jwt.sign(
    { userId, platformRole, isSuperAdmin: true },
    process.env.JWT_SECRET!,
    { expiresIn: '8h' }
  );
}
