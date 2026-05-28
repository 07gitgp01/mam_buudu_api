import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { StorageClient } from '@supabase/storage-js';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

// ── Supabase Storage (sans Realtime, compatible Node 20) ──
const SUPABASE_URL  = process.env.SUPABASE_URL!;
const SUPABASE_KEY  = process.env.SUPABASE_KEY!;
const STORAGE_URL   = `${SUPABASE_URL}/storage/v1`;
const BUCKET        = 'photos';

const storage = new StorageClient(STORAGE_URL, {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
});

// Crée le bucket public au démarrage si nécessaire
(async () => {
  const { error } = await storage.createBucket(BUCKET, { public: true });
  if (error && !error.message.toLowerCase().includes('already exists')) {
    console.warn('[storage] bucket init:', error.message);
  }
})();

// Extrait le chemin relatif depuis une URL Supabase Storage
function extractStoragePath(url: string): string | null {
  try {
    const marker = `/object/public/${BUCKET}/`;
    const idx = url.indexOf(marker);
    return idx !== -1 ? url.slice(idx + marker.length) : null;
  } catch {
    return null;
  }
}

// ── Multer en mémoire (pas de disque local) ────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format non supporté (jpeg, png, webp, gif uniquement)'));
    }
  },
});

// ── POST /api/uploads/photo/:personneId ─────────
router.post(
  '/photo/:personneId',
  upload.single('photo'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'Aucun fichier reçu' });
      return;
    }

    try {
      const personne = await prisma.personne.findFirst({
        where: { id: req.params.personneId, familleId: req.user!.familleId },
      });

      if (!personne) {
        res.status(404).json({ error: 'Personne introuvable' });
        return;
      }

      // Supprime l'ancienne photo Supabase si elle existe
      if (personne.photoUrl) {
        const oldPath = extractStoragePath(personne.photoUrl);
        if (oldPath) await storage.from(BUCKET).remove([oldPath]);
      }

      // Chemin de stockage : familleId/timestamp-random.ext
      const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
      const storagePath = `${req.user!.familleId}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

      // Upload vers Supabase Storage
      const { error: uploadError } = await storage
        .from(BUCKET)
        .upload(storagePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error('[storage] upload error:', uploadError);
        res.status(500).json({ error: "Erreur lors de l'upload" });
        return;
      }

      // URL publique permanente
      const { data } = storage.from(BUCKET).getPublicUrl(storagePath);
      const photoUrl = data.publicUrl;

      const updated = await prisma.personne.update({
        where: { id: req.params.personneId },
        data: { photoUrl },
      });

      res.json({ photoUrl: updated.photoUrl });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erreur lors de l'upload" });
    }
  }
);

// ── DELETE /api/uploads/photo/:personneId ───────
router.delete('/photo/:personneId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const personne = await prisma.personne.findFirst({
      where: { id: req.params.personneId, familleId: req.user!.familleId },
    });

    if (!personne) {
      res.status(404).json({ error: 'Personne introuvable' });
      return;
    }

    if (personne.photoUrl) {
      const storagePath = extractStoragePath(personne.photoUrl);
      if (storagePath) await storage.from(BUCKET).remove([storagePath]);
    }

    await prisma.personne.update({
      where: { id: req.params.personneId },
      data: { photoUrl: null },
    });

    res.json({ message: 'Photo supprimée' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur' });
  }
});

export default router;
