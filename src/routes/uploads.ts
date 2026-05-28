import { Router, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

// ── Cloudinary ───────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Extrait le public_id Cloudinary depuis une URL
// ex: https://res.cloudinary.com/ds4n9exfm/image/upload/v.../mam-buudu/abc123.jpg
//     → mam-buudu/abc123
function extractPublicId(url: string): string | null {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ── Multer en mémoire ────────────────────────────
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

      // Supprime l'ancienne photo Cloudinary si elle existe
      if (personne.photoUrl) {
        const oldId = extractPublicId(personne.photoUrl);
        if (oldId) await cloudinary.uploader.destroy(oldId).catch(() => {});
      }

      // Upload vers Cloudinary (depuis le buffer mémoire)
      const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `mam-buudu/${req.user!.familleId}`,
            resource_type: 'image',
            transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
          },
          (err, result) => {
            if (err || !result) return reject(err ?? new Error('Upload échoué'));
            resolve(result as { secure_url: string });
          }
        );
        stream.end(req.file!.buffer);
      });

      const updated = await prisma.personne.update({
        where: { id: req.params.personneId },
        data: { photoUrl: result.secure_url },
      });

      res.json({ photoUrl: updated.photoUrl });
    } catch (err) {
      console.error('[cloudinary] upload error:', err);
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
      const publicId = extractPublicId(personne.photoUrl);
      if (publicId) await cloudinary.uploader.destroy(publicId).catch(() => {});
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
