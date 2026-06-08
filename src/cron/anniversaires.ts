import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { sendEmail, tplBirthday } from '../lib/mailer';

// ── Vérification anniversaires du jour ───────────────────────────────────────
export async function checkAnniversaires(): Promise<void> {
  try {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day   = String(today.getDate()).padStart(2, '0');
    const suffix = `-${month}-${day}`;

    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay   = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    const personnes = await prisma.personne.findMany({
      where: {
        dateNaissance: { endsWith: suffix },
        dateDeces: null,
      },
      include: {
        famille: {
          include: {
            membres: { include: { user: true } },
          },
        },
      },
    });

    console.log(`[cron] anniversaires du ${day}/${month} : ${personnes.length} personne(s)`);

    for (const personne of personnes) {
      const nom = [personne.prenoms, personne.nomNaissance].filter(Boolean).join(' ') || 'Inconnu';
      const anneeNaissance = personne.dateNaissance?.split('-')[0];
      const age = anneeNaissance ? today.getFullYear() - parseInt(anneeNaissance) : null;
      const titre  = `Anniversaire de ${nom}`;
      const message = age
        ? `${nom} fête ses ${age} ans aujourd'hui ! 🎂`
        : `C'est l'anniversaire de ${nom} aujourd'hui ! 🎂`;

      for (const membre of personne.famille.membres) {
        const existing = await prisma.notification.findFirst({
          where: {
            userId:    membre.userId,
            type:      'anniversaire',
            createdAt: { gte: startOfDay, lt: endOfDay },
            data: { path: ['personneId'], equals: personne.id },
          },
        });

        if (!existing) {
          await prisma.notification.create({
            data: {
              familleId: personne.familleId,
              userId:    membre.userId,
              type:      'anniversaire',
              titre,
              message,
              data: {
                personneId: personne.id,
                nom,
                age,
                photoUrl: personne.photoUrl ?? null,
              },
            },
          });

          if (membre.user.email) {
            await sendEmail({
              to:      membre.user.email,
              subject: `🎂 Anniversaire de ${nom} — Famille ${personne.famille.nom}`,
              html:    tplBirthday(`${membre.user.prenom} ${membre.user.nom}`, personne.famille.nom, nom, age),
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[cron] erreur anniversaires:', err);
  }
}

// ── Démarrage du cron ─────────────────────────────────────────────────────────
export function startCronJobs(): void {
  cron.schedule('0 8 * * *', () => {
    console.log('[cron] vérification anniversaires…');
    checkAnniversaires();
  });
  console.log('[cron] job anniversaires enregistré (quotidien 08h00)');
}
