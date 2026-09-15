import { AuthRequest } from '../types';

/**
 * Masque la biographie/les notes des personnes marquées "privé" aux membres
 * simples et aux liens lecture-seule — la personne reste visible dans l'arbre
 * (nom, dates, photo), seules ses informations sensibles sont retirées.
 */
export function redactPersonne<T extends { visibilite: string; biographie: string | null; notes: string | null }>(
  personne: T,
  req: AuthRequest,
): T {
  const isPrivileged = !req.user!.isViewonly && req.user!.role !== 'membre';
  if (personne.visibilite !== 'prive' || isPrivileged) return personne;
  return { ...personne, biographie: null, notes: null };
}
