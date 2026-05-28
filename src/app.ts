import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';

import authRouter from './routes/auth';
import personnesRouter from './routes/personnes';
import unionsRouter from './routes/unions';
import famillesRouter from './routes/familles';
import uploadsRouter from './routes/uploads';
import syncRouter from './routes/sync';
import { prisma } from './lib/prisma';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Sécurité ────────────────────────────────────
app.use(helmet());
console.log('CORS_ORIGIN env:', process.env.CORS_ORIGIN);
const corsOrigins = process.env.CORS_ORIGIN?.trim()
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : '*';

console.log('CORS_ORIGIN parsed:', corsOrigins);

app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
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

// ── Health check ────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 ──────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// ── Erreurs globales ─────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ── Nettoyage des vieilles URLs Render (éphémères) ──
async function cleanOldRenderPhotos(): Promise<void> {
  try {
    const { count } = await prisma.personne.updateMany({
      where: { photoUrl: { contains: 'onrender.com/uploads/' } },
      data: { photoUrl: null },
    });
    if (count > 0) console.log(`[startup] ${count} ancienne(s) photo(s) Render nettoyée(s)`);
  } catch (e) {
    console.warn('[startup] nettoyage photos:', e);
  }
}

// ── Démarrage ────────────────────────────────────
app.listen(PORT, async () => {
  console.log(` Mam Buudu API démarrée sur le port ${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`);
  await cleanOldRenderPhotos();
});

export default app;
