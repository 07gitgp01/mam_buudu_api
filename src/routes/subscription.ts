import { Router, Response, Request } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';
import { checkPersonneQuota, FREE_LIMIT, FREE_PLAN_ID, getActiveSubscription } from '../lib/quota';

const router = Router();

const CINETPAY_API = 'https://api-checkout.cinetpay.com/v2/payment';

// ── GET /api/subscription/plans ───────────────────────────────────────────────
router.get('/plans', async (_req: Request, res: Response): Promise<void> => {
  try {
    const plans = await prisma.plan.findMany({ orderBy: { prix: 'asc' } });
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/subscription ─────────────────────────────────────────────────────
// Retourne l'abonnement courant + quota d'utilisation
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const familleId = req.user!.familleId;
    const [sub, quota] = await Promise.all([
      getActiveSubscription(familleId),
      checkPersonneQuota(familleId),
    ]);

    if (!sub) {
      // Pas d'abonnement → plan gratuit virtuel
      const planGratuit = await prisma.plan.findUnique({ where: { id: FREE_PLAN_ID } });
      res.json({
        plan: planGratuit,
        statut: 'actif',
        dateFin: null,
        current: quota.current,
        limit: FREE_LIMIT,
        pourcentage: Math.min(100, Math.round((quota.current / FREE_LIMIT) * 100)),
      });
      return;
    }

    const active = sub.statut === 'actif' && (!sub.dateFin || sub.dateFin > new Date());
    const limit  = active ? sub.plan.maxPersonnes : FREE_LIMIT;

    res.json({
      plan:        active ? sub.plan : await prisma.plan.findUnique({ where: { id: FREE_PLAN_ID } }),
      statut:      active ? 'actif' : 'expire',
      dateFin:     sub.dateFin,
      current:     quota.current,
      limit,
      pourcentage: limit === null ? 0 : Math.min(100, Math.round((quota.current / limit) * 100)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/subscription/checkout ──────────────────────────────────────────
// Initie un paiement CinetPay, retourne l'URL de paiement
router.post('/checkout', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { planId } = req.body;
  if (!planId || planId === FREE_PLAN_ID) {
    res.status(400).json({ error: 'Plan invalide' });
    return;
  }

  try {
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || plan.prix === 0) {
      res.status(400).json({ error: 'Plan introuvable' });
      return;
    }

    const apikey  = process.env.CINETPAY_API_KEY;
    const site_id = process.env.CINETPAY_SITE_ID;

    if (!apikey || !site_id) {
      res.status(503).json({ error: 'Paiement en ligne non configuré. Contactez l\'administrateur.' });
      return;
    }

    const user       = req.user!;
    const transId    = `MB-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const returnUrl  = `${process.env.FRONTEND_URL ?? 'https://mam-buudu.vercel.app'}/app/admin?payment=success`;
    const notifyUrl  = `${process.env.API_URL ?? 'https://mam-buudu-api.onrender.com'}/api/subscription/webhook`;

    const payload = {
      apikey,
      site_id,
      transaction_id: transId,
      amount:         plan.prix,
      currency:       'XOF',
      description:    `Abonnement ${plan.label} — Mam Buudu`,
      return_url:     returnUrl,
      notify_url:     notifyUrl,
      customer_name:  user.nom,
      customer_surname: user.prenom,
      customer_email: user.email ?? '',
      metadata:       JSON.stringify({ familleId: user.familleId, planId }),
    };

    const response = await fetch(CINETPAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json() as any;

    if (data.code !== '201') {
      console.error('[cinetpay] init error:', data);
      res.status(502).json({ error: 'Échec de l\'initialisation du paiement' });
      return;
    }

    // Créer ou récupérer la subscription (en attente)
    let sub = await prisma.subscription.findUnique({ where: { familleId: user.familleId } });
    if (!sub) {
      sub = await prisma.subscription.create({
        data: {
          familleId: user.familleId,
          planId:    FREE_PLAN_ID,
          statut:    'actif',
          dateDebut: new Date(),
        },
      });
    }

    // Enregistrer le paiement en attente
    await prisma.paiement.create({
      data: {
        subscriptionId: sub.id,
        transactionId:  transId,
        montant:        plan.prix,
        statut:         'pending',
        metadata:       { planId, familleId: user.familleId },
      },
    });

    res.json({ paymentUrl: data.data.payment_url, transactionId: transId });
  } catch (err) {
    console.error('[cinetpay] checkout error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/subscription/webhook ───────────────────────────────────────────
// Appelé par CinetPay après paiement (sans authentification)
router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  try {
    const { cpm_trans_id } = req.body;
    if (!cpm_trans_id) { res.sendStatus(200); return; }

    const paiement = await prisma.paiement.findUnique({
      where:   { transactionId: cpm_trans_id },
      include: { subscription: true },
    });

    if (!paiement || paiement.statut === 'success') { res.sendStatus(200); return; }

    // Vérification auprès de CinetPay
    const apikey  = process.env.CINETPAY_API_KEY;
    const site_id = process.env.CINETPAY_SITE_ID;

    const check = await fetch('https://api-checkout.cinetpay.com/v2/payment/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey, site_id, transaction_id: cpm_trans_id }),
    });

    const result = await check.json() as any;
    const success = result.code === '00' && result.data?.status === 'ACCEPTED';

    if (success) {
      const meta    = paiement.metadata as any;
      const planId  = meta?.planId;
      const dateFin = new Date();
      dateFin.setMonth(dateFin.getMonth() + 1);

      await prisma.$transaction([
        prisma.paiement.update({
          where: { id: paiement.id },
          data:  { statut: 'success' },
        }),
        prisma.subscription.update({
          where: { id: paiement.subscriptionId },
          data:  { planId, statut: 'actif', dateDebut: new Date(), dateFin },
        }),
      ]);

      console.log(`[webhook] subscription activée → plan ${planId} pour famille ${paiement.subscription.familleId}`);
    } else {
      await prisma.paiement.update({
        where: { id: paiement.id },
        data:  { statut: 'failed' },
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook] error:', err);
    res.sendStatus(200); // toujours 200 pour CinetPay
  }
});

export default router;
