import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import pinoHttp from 'pino-http';

import { logger } from './lib/logger';
import { swaggerSpec } from './lib/swagger';
import authRouter from './routes/auth';
import personnesRouter from './routes/personnes';
import unionsRouter from './routes/unions';
import famillesRouter from './routes/familles';
import uploadsRouter from './routes/uploads';
import syncRouter from './routes/sync';
import storiesRouter from './routes/stories';
import searchRouter from './routes/search';
import photosRouter from './routes/photos';
import notificationsRouter from './routes/notifications';
import exportRouter from './routes/export';
import subscriptionRouter from './routes/subscription';
import timelineRouter from './routes/timeline';
import activityRouter from './routes/activity';
import importRouter from './routes/import';
import pushRouter from './routes/push';
import superadminRouter from './routes/superadmin';
import { startCronJobs } from './cron/anniversaires';
import { seedPlans } from './lib/quota';
import { prisma } from './lib/prisma';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Observabilité ─────────────────────────────────
app.use(pinoHttp({ logger }));

// ── Sécurité ────────────────────────────────────
app.use(helmet());
logger.info({ corsOriginEnv: process.env.CORS_ORIGIN ?? null }, 'CORS_ORIGIN env');
const isProduction = process.env.NODE_ENV === 'production';
let corsOrigins: string | string[];
if (process.env.CORS_ORIGIN?.trim()) {
  corsOrigins = process.env.CORS_ORIGIN.split(',').map((o) => o.trim());
} else if (isProduction) {
  // CORS_ORIGIN non configuré en prod : on referme sur le frontend connu
  // plutôt que d'autoriser toutes les origines.
  logger.warn('[cors] CORS_ORIGIN non défini en production — repli sur le frontend officiel uniquement.');
  corsOrigins = [process.env.FRONTEND_URL ?? 'https://mam-buudu.vercel.app'];
} else {
  corsOrigins = '*';
}

logger.info({ corsOrigins }, 'CORS_ORIGIN parsed');

app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));


// Rate limiting global : 200 req / 15 min par IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' },
}));

// ── Parsing ─────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Fichiers statiques (photos uploadées localement) ──
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ── Routes ──────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/familles', famillesRouter);
app.use('/api/personnes', personnesRouter);
app.use('/api/unions', unionsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/stories', storiesRouter);
app.use('/api/search',        searchRouter);
app.use('/api/photos',        photosRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/export',        exportRouter);
app.use('/api/subscription',  subscriptionRouter);
app.use('/api/timeline',      timelineRouter);
app.use('/api/activity',      activityRouter);
app.use('/api/import',        importRouter);
app.use('/api/push',          pushRouter);
app.use('/api/superadmin',    superadminRouter);

// ── Documentation API ─────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── Health check ────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 ──────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// ── Erreurs globales ─────────────────────────────
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err, path: req.path }, 'Erreur non gérée');
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ── Nettoyage des vieilles URLs Render (éphémères) ──
async function cleanOldRenderPhotos(): Promise<void> {
  try {
    const { count } = await prisma.personne.updateMany({
      where: { photoUrl: { contains: 'onrender.com/uploads/' } },
      data: { photoUrl: null },
    });
    if (count > 0) logger.info({ count }, 'ancienne(s) photo(s) Render nettoyée(s)');
  } catch (e) {
    logger.warn({ err: e }, 'nettoyage photos échoué');
  }
}

// ── Démarrage ────────────────────────────────────
app.listen(PORT, async () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'Mam Buudu API démarrée');
  await cleanOldRenderPhotos();
  await seedPlans();
  startCronJobs();
});

export default app;
