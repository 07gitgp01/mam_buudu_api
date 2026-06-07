import { Router, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const albumUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 Mo
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── GET /api/photos/:personneId ───────────────────────────
router.get('/:personneId', async (req: AuthRequest, res: Response): Promise<void> => {
  const { personneId } = req.params;
  try {
    const personne = await prisma.personne.findFirst({
      where: { id: personneId, familleId: req.user!.familleId },
    });
    if (!personne) { res.status(404).json({ error: 'Personne introuvable' }); return; }

    const photos = await prisma.photo.findMany({
      where: { personneId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(photos);
  } catch (err) {
    console.error('[photos GET]', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ── POST /api/photos/:personneId ─────────────────────────
router.post('/:personneId', albumUpload.single('photo'), async (req: AuthRequest, res: Response): Promise<void> => {
  const { personneId } = req.params;
  const { caption, datePrise, lieuPrise } = req.body;

  if (!req.file) { res.status(400).json({ error: 'Aucun fichier reçu' }); return; }

  try {
    const personne = await prisma.personne.findFirst({
      where: { id: personneId, familleId: req.user!.familleId },
    });
    if (!personne) { res.status(404).json({ error: 'Personne introuvable' }); return; }

    const result = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `mam-buudu/${req.user!.familleId}/albums/${personneId}`,
          resource_type: 'image',
          transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        },
        (err, result) => err ? reject(err) : resolve(result),
      );
      stream.end(req.file!.buffer);
    });

    const photo = await prisma.photo.create({
      data: {
        personneId,
        familleId: req.user!.familleId,
        url:       result.secure_url,
        caption:   caption   || null,
        datePrise: datePrise  || null,
        lieuPrise: lieuPrise  || null,
      },
    });

    res.status(201).json(photo);
  } catch (err) {
    console.error('[photos POST]', err);
    res.status(500).json({ error: 'Erreur upload' });
  }
});

// ── DELETE /api/photos/:photoId ──────────────────────────
router.delete('/:photoId', async (req: AuthRequest, res: Response): Promise<void> => {
  const { photoId } = req.params;
  try {
    const photo = await prisma.photo.findFirst({
      where: { id: photoId, familleId: req.user!.familleId },
    });
    if (!photo) { res.status(404).json({ error: 'Photo introuvable' }); return; }

    // Supprimer sur Cloudinary
    const match = photo.url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
    if (match) {
      await cloudinary.uploader.destroy(match[1]).catch(() => {});
    }

    await prisma.photo.delete({ where: { id: photoId } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[photos DELETE]', err);
    res.status(500).json({ error: 'Erreur suppression' });
  }
});

// ── PATCH /api/photos/:photoId ───────────────────────────
router.patch('/:photoId', async (req: AuthRequest, res: Response): Promise<void> => {
  const { photoId } = req.params;
  const { caption, datePrise, lieuPrise } = req.body;
  try {
    const photo = await prisma.photo.findFirst({
      where: { id: photoId, familleId: req.user!.familleId },
    });
    if (!photo) { res.status(404).json({ error: 'Photo introuvable' }); return; }

    const updated = await prisma.photo.update({
      where: { id: photoId },
      data: {
        caption:   caption   ?? photo.caption,
        datePrise: datePrise ?? photo.datePrise,
        lieuPrise: lieuPrise ?? photo.lieuPrise,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error('[photos PATCH]', err);
    res.status(500).json({ error: 'Erreur mise à jour' });
  }
});

export default router;
