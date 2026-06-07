import { prisma } from './prisma';

export const FREE_PLAN_ID = 'plan_gratuit';
export const FREE_LIMIT   = 50;

export async function getActiveSubscription(familleId: string) {
  return prisma.subscription.findUnique({
    where: { familleId },
    include: { plan: true },
  });
}

export async function getPersonneLimit(familleId: string): Promise<number | null> {
  const sub = await getActiveSubscription(familleId);
  if (sub && sub.statut === 'actif') {
    const notExpired = !sub.dateFin || sub.dateFin > new Date();
    if (notExpired) return sub.plan.maxPersonnes; // null = illimité
  }
  return FREE_LIMIT;
}

export async function checkPersonneQuota(
  familleId: string,
): Promise<{ allowed: boolean; limit: number | null; current: number }> {
  const [limit, current] = await Promise.all([
    getPersonneLimit(familleId),
    prisma.personne.count({ where: { familleId } }),
  ]);
  return { allowed: limit === null || current < limit, limit, current };
}

// Insère les 3 plans par défaut s'ils n'existent pas encore
export async function seedPlans(): Promise<void> {
  const plans = [
    {
      id: 'plan_gratuit',
      nom: 'gratuit',
      label: 'Gratuit',
      prix: 0,
      maxPersonnes: 50,
      features: ['50 membres dans l\'arbre', 'Arbre familial', 'Stories', 'Export GEDCOM', 'Notifications anniversaires'],
    },
    {
      id: 'plan_premium',
      nom: 'premium',
      label: 'Premium',
      prix: 3000,
      maxPersonnes: 500,
      features: ['500 membres dans l\'arbre', 'Toutes les fonctionnalités Gratuit', 'Albums photos illimités', 'Recherche avancée', 'Support prioritaire'],
    },
    {
      id: 'plan_famille_plus',
      nom: 'famille_plus',
      label: 'Famille+',
      prix: 8000,
      maxPersonnes: null,
      features: ['Membres illimités', 'Toutes les fonctionnalités Premium', 'Accès anticipé aux nouvelles fonctionnalités'],
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where:  { id: plan.id },
      update: { label: plan.label, prix: plan.prix, maxPersonnes: plan.maxPersonnes, features: plan.features },
      create: plan,
    });
  }
}
