import cron from 'node-cron';
import nodemailer from 'nodemailer';
import { prisma } from '../lib/prisma';

// ── Mailer (optionnel — désactivé si SMTP_HOST absent) ───────────────────────
function createTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendBirthdayEmail(
  to: string,
  nomDestinataire: string,
  nomFamille: string,
  nomAnniversaire: string,
  age: number | null,
): Promise<void> {
  const transport = createTransport();
  if (!transport) return;

  const ageText = age ? `${age} ans` : 'un anniversaire';
  await transport.sendMail({
    from: `"Mam Buudu" <${process.env.SMTP_USER}>`,
    to,
    subject: `🎂 Anniversaire de ${nomAnniversaire} — Famille ${nomFamille}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#f9fafb;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#1e3a8a,#1d4ed8);padding:28px 24px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:22px;">🎂 Anniversaire !</h1>
        </div>
        <div style="padding:24px;">
          <p style="font-size:15px;color:#374151;">Bonjour <strong>${nomDestinataire}</strong>,</p>
          <p style="font-size:15px;color:#374151;">
            Aujourd'hui, <strong>${nomAnniversaire}</strong> fête <strong>${ageText}</strong>
            dans la famille <strong>${nomFamille}</strong> ! 🎉
          </p>
          <p style="font-size:13px;color:#6B7280;margin-top:24px;">
            Connectez-vous sur <a href="https://mam-buudu.vercel.app" style="color:#2563EB;">Mam Buudu</a> pour lui souhaiter un joyeux anniversaire.
          </p>
        </div>
      </div>
    `,
  }).catch(err => console.warn('[email] envoi échoué:', err.message));
}

// ── Vérification anniversaires du jour ───────────────────────────────────────
export async function checkAnniversaires(): Promise<void> {
  try {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day   = String(today.getDate()).padStart(2, '0');
    const suffix = `-${month}-${day}`;

    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay   = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    // Personnes dont la date de naissance se termine par -MM-DD
    const personnes = await prisma.personne.findMany({
      where: {
        dateNaissance: { endsWith: suffix },
        dateDeces: null,
      },
      include: {
        famille: {
          include: {
            membres: {
              include: { user: true },
            },
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
        // Éviter les doublons : une notif par personne + par jour
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
        }

        // Email si le membre a une adresse email
        if (membre.user.email && !existing) {
          await sendBirthdayEmail(
            membre.user.email,
            `${membre.user.prenom} ${membre.user.nom}`,
            personne.famille.nom,
            nom,
            age,
          );
        }
      }
    }
  } catch (err) {
    console.error('[cron] erreur anniversaires:', err);
  }
}

// ── Démarrage du cron ─────────────────────────────────────────────────────────
export function startCronJobs(): void {
  // Chaque jour à 08h00
  cron.schedule('0 8 * * *', () => {
    console.log('[cron] vérification anniversaires…');
    checkAnniversaires();
  });

  console.log('[cron] job anniversaires enregistré (quotidien 08h00)');
}
