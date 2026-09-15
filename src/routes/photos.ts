import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../lib/prisma';
import { requireAuth, requireManage } from '../middleware/auth';
import { AuthRequest } from '../types';
import { notifyFamille } from '../lib/notifications';

const router = Router();
router.use(requireAuth);

const photoMetaSchema = z.object({
  caption:   z.string().max(500).optional().nullable(),
  datePrise: z.string().max(10).optional().nullable(),
  lieuPrise: z.string().max(200).optional().nullable(),
});

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

/**
 * @openapi
 * /api/photos:
 *   get:
 *     tags: [Photos]
 *     summary: Galerie photo paginée de toute la famille (toutes personnes confondues)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 24, maximum: 100 }
 *     responses:
 *       200:
 *         description: "{ data, total, page, limit, totalPages }"
 */
// ── GET /api/photos ────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '24'), 10) || 24));

    const where = { familleId: req.user!.familleId };

    const [photos, total] = await Promise.all([
      prisma.photo.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { personne: { select: { id: true, prenoms: true, nomNaissance: true, nomUsage: true } } },
      }),
      prisma.photo.count({ where }),
    ]);

    res.json({
      data: photos.map(p => ({
        id:         p.id,
        url:        p.url,
        caption:    p.caption,
        datePrise:  p.datePrise,
        lieuPrise:  p.lieuPrise,
        createdAt:  p.createdAt.toISOString(),
        personneId: p.personneId,
        personneNom: [p.personne.prenoms, p.personne.nomUsage ?? p.personne.nomNaissance].filter(Boolean).join(' ') || null,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('[photos GET all]', err);
    res.status(500).json({ error: 'Erreur' });
  }
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
router.post('/:personneId', requireManage, albumUpload.single('photo'), async (req: AuthRequest, res: Response): Promise<void> => {
  const { personneId } = req.params;

  if (!req.file) { res.status(400).json({ error: 'Aucun fichier reçu' }); return; }

  const parse = photoMetaSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { caption, datePrise, lieuPrise } = parse.data;

  // multipart/form-data : les champs non-fichier arrivent en chaînes — le tableau
  // de destinataires est donc envoyé encodé en JSON par le client.
  let notifyUserIds: string[] | null = null;
  if (typeof req.body.notifyUserIds === 'string') {
    try {
      const parsed = JSON.parse(req.body.notifyUserIds);
      if (Array.isArray(parsed)) notifyUserIds = parsed;
    } catch { /* ignoré — équivaut à "toute la famille" */ }
  }

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

    // Notifier tous les membres (sauf l'uploader)
    const nomPersonne = [personne.prenoms, personne.nomNaissance].filter(Boolean).join(' ') || 'Inconnu';
    notifyFamille(req.user!.familleId, req.user!.id, {
      type:    'photo_ajoutee',
      titre:   `Nouvelle photo de ${nomPersonne}`,
      message: caption ? `"${caption}"` : `Photo ajoutée à l'album de ${nomPersonne}`,
      data:    { personneId, photoUrl: photo.url, nom: nomPersonne },
    }, notifyUserIds);
  } catch (err) {
    console.error('[photos POST]', err);
    res.status(500).json({ error: 'Erreur upload' });
  }
});

// ── DELETE /api/photos/:photoId ──────────────────────────
router.delete('/:photoId', requireManage, async (req: AuthRequest, res: Response): Promise<void> => {
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
router.patch('/:photoId', requireManage, async (req: AuthRequest, res: Response): Promise<void> => {
  const { photoId } = req.params;

  const parse = photoMetaSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { caption, datePrise, lieuPrise } = parse.data;

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
