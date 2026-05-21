import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

// ── Multer : stockage local dans /uploads ───────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
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
// Upload la photo d'une personne et met à jour photoUrl
router.post(
  '/photo/:personneId',
  upload.single('photo'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'Aucun fichier reçu' });
      return;
    }

    try {
      // Vérifie que la personne appartient à la famille
      const personne = await prisma.personne.findFirst({
        where: { id: req.params.personneId, familleId: req.user!.familleId },
      });

      if (!personne) {
        // Supprime le fichier uploadé inutilement
        fs.unlink(req.file.path, () => {});
        res.status(404).json({ error: 'Personne introuvable' });
        return;
      }

      // Supprime l'ancienne photo locale si elle existe
      if (personne.photoUrl) {
        const oldFilename = path.basename(personne.photoUrl);
        const oldPath = path.join(__dirname, '..', '..', 'uploads', oldFilename);
        if (fs.existsSync(oldPath)) fs.unlink(oldPath, () => {});
      }

      // Construit l'URL publique
      const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      const photoUrl = `${baseUrl}/uploads/${req.file.filename}`;

      // Met à jour la personne
      const updated = await prisma.personne.update({
        where: { id: req.params.personneId },
        data: { photoUrl },
      });

      res.json({ photoUrl: updated.photoUrl });
    } catch (err) {
      // Nettoie le fichier en cas d'erreur
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error(err);
      res.status(500).json({ error: 'Erreur lors de l\'upload' });
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
      const filename = path.basename(personne.photoUrl);
      const filePath = path.join(__dirname, '..', '..', 'uploads', filename);
      if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
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
