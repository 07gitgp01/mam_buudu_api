import { Resend } from 'resend';
import nodemailer from 'nodemailer';

// ── Resend (prioritaire si RESEND_API_KEY défini) ────────────────────────────
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// ── SMTP nodemailer (fallback) ───────────────────────────────────────────────
let _transport: nodemailer.Transporter | null = null;

function getSmtpTransport(): nodemailer.Transporter | null {
  if (!process.env.SMTP_HOST) return null;
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT ?? '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _transport;
}

// ── Interface commune ─────────────────────────────────────────────────────────
export async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<boolean> {
  const resend = getResend();

  if (resend) {
    const from = process.env.SMTP_FROM ?? 'Mam Buudu <onboarding@resend.dev>';
    try {
      const { error } = await resend.emails.send({ from, ...opts });
      if (error) {
        console.error('[mailer/resend] Erreur:', error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[mailer/resend] Exception:', err);
      return false;
    }
  }

  const smtp = getSmtpTransport();
  if (smtp) {
    try {
      await smtp.sendMail({
        from: process.env.SMTP_FROM ?? `"Mam Buudu" <${process.env.SMTP_USER}>`,
        ...opts,
      });
      return true;
    } catch (err) {
      console.error('[mailer/smtp] Erreur:', err);
      return false;
    }
  }

  console.log(`[mailer] Aucun service email configuré — email ignoré pour ${opts.to}`);
  return false;
}

// ── Templates ─────────────────────────────────────────────────────────────────

export function tplPasswordReset(nom: string, lien: string): string {
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;padding:32px">
      <h2 style="color:#1e3a5f">Réinitialisation de mot de passe</h2>
      <p>Bonjour <strong>${nom}</strong>,</p>
      <p>Vous avez demandé une réinitialisation de votre mot de passe Mam Buudu.</p>
      <p>Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p>
      <p style="text-align:center;margin:32px 0">
        <a href="${lien}" style="background:#2563eb;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;display:inline-block">
          Réinitialiser mon mot de passe
        </a>
      </p>
      <p style="color:#666;font-size:13px">Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <p style="color:#aaa;font-size:12px;text-align:center">Mam Buudu — Votre arbre généalogique familial</p>
    </div>`;
}

export function tplEmailVerification(nom: string, lien: string): string {
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;padding:32px">
      <h2 style="color:#1e3a5f">Vérification de votre adresse email</h2>
      <p>Bonjour <strong>${nom}</strong>,</p>
      <p>Bienvenue sur <strong>Mam Buudu</strong> ! Confirmez votre adresse email pour activer votre compte.</p>
      <p style="text-align:center;margin:32px 0">
        <a href="${lien}" style="background:#059669;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;display:inline-block">
          Vérifier mon adresse email
        </a>
      </p>
      <p style="color:#666;font-size:13px">Ce lien est valable <strong>24 heures</strong>.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <p style="color:#aaa;font-size:12px;text-align:center">Mam Buudu — Votre arbre généalogique familial</p>
    </div>`;
}

export function tplOtp(code: string): string {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px">
      <h2 style="color:#1e3a5f;margin-bottom:8px">Votre code de vérification</h2>
      <p>Utilisez ce code pour finaliser votre inscription sur <strong>Mam Buudu</strong> :</p>
      <div style="text-align:center;margin:32px 0">
        <span style="display:inline-block;background:#f0f4ff;border:2px solid #2563eb;border-radius:12px;
                     padding:16px 40px;font-size:36px;font-weight:800;letter-spacing:12px;color:#1e3a5f">
          ${code}
        </span>
      </div>
      <p style="color:#666;font-size:13px">Ce code est valable <strong>10 minutes</strong>. Ne le partagez avec personne.</p>
      <p style="color:#999;font-size:12px">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <p style="color:#aaa;font-size:12px;text-align:center">Mam Buudu — Votre arbre généalogique familial</p>
    </div>`;
}

export function tplBirthday(nomDestinataire: string, nomFamille: string, nomAnniversaire: string, age: number | null): string {
  const ageText = age ? `${age} ans` : 'un anniversaire';
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;padding:32px">
      <h2 style="color:#ea580c">🎂 Anniversaire aujourd'hui !</h2>
      <p>Bonjour <strong>${nomDestinataire}</strong>,</p>
      <p>Dans la famille <strong>${nomFamille}</strong>, <strong>${nomAnniversaire}</strong> fête aujourd'hui ${ageText} !</p>
      <p style="text-align:center;font-size:48px;margin:24px 0">🎉🎂🎊</p>
      <p>Prenez un moment pour lui souhaiter un joyeux anniversaire.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <p style="color:#aaa;font-size:12px;text-align:center">Mam Buudu — Votre arbre généalogique familial</p>
    </div>`;
}
