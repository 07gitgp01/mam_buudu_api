import { Router, Response } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { requireAuth, requireManage } from '../middleware/auth';
import { AuthRequest } from '../types';
import { parseGedcom, GedcomParseError } from '../lib/gedcom';
import { logActivity } from '../lib/activityLog';
import { logger } from '../lib/logger';

const router = Router();
router.use(requireAuth);

const gedcomUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo — largement suffisant pour un GEDCOM texte
  fileFilter: (_req, file, cb) => {
    cb(null, /\.(ged|gedcom)$/i.test(file.originalname));
  },
});

/**
 * @openapi
 * /api/import/gedcom:
 *   post:
 *     tags: [Import]
 *     summary: >
 *       Importe un fichier GEDCOM dans l'arbre de la famille. N'est autorisé que si
 *       la famille ne contient encore aucune personne (pas de fusion — évite tout
 *       risque de doublon ou de corruption d'un arbre existant). Import atomique :
 *       en cas d'erreur, rien n'est écrit en base.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: "Import réussi — { personnesCreees, unionsCreees }" }
 *       400: { description: "Fichier invalide ou illisible" }
 *       403: { description: "La famille contient déjà des personnes" }
 */
router.post('/gedcom', requireManage, gedcomUpload.single('fichier'), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'Aucun fichier reçu (extension attendue : .ged)' });
    return;
  }

  const familleId = req.user!.familleId;

  try {
    // Garde-fou : on refuse toute fusion avec un arbre existant pour cette V1.
    const existant = await prisma.personne.count({ where: { familleId } });
    if (existant > 0) {
      res.status(403).json({
        error: "Import impossible : votre arbre contient déjà des personnes. L'import GEDCOM n'est disponible que sur un arbre vide, pour éviter tout doublon.",
      });
      return;
    }

    let doc;
    try {
      doc = parseGedcom(req.file.buffer.toString('utf-8'));
    } catch (e) {
      if (e instanceof GedcomParseError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }

    const result = await prisma.$transaction(async (tx) => {
      const idMap = new Map<string, string>(); // gedcomId → nouvel id Personne

      for (const ind of doc.individus) {
        const personne = await tx.personne.create({
          data: {
            familleId,
            prenoms:       ind.prenoms,
            nomNaissance:  ind.nomNaissance,
            sexe:          ind.sexe,
            dateNaissance: ind.dateNaissance,
            lieuNaissance: ind.lieuNaissance,
            dateDeces:     ind.dateDeces,
            lieuDeces:     ind.lieuDeces,
          },
        });
        idMap.set(ind.gedcomId, personne.id);
      }

      let unionsCreees = 0;
      for (const fam of doc.familles) {
        const husbandId = fam.husbandId ? idMap.get(fam.husbandId) : null;
        const wifeId    = fam.wifeId    ? idMap.get(fam.wifeId)    : null;
        const parentIds = [husbandId, wifeId].filter((id): id is string => !!id);
        const enfantIds = fam.childrenIds.map(cid => idMap.get(cid)).filter((id): id is string => !!id);

        // Une union sans aucun conjoint ni enfant n'apporte rien à l'arbre — on l'ignore.
        if (parentIds.length === 0 && enfantIds.length === 0) continue;

        await tx.union.create({
          data: {
            familleId,
            participants: { create: parentIds.map((pid, i) => ({ personneId: pid, role: 'conjoint', ordre: i })) },
            filiations:   { create: enfantIds.map((eid, i) => ({ enfantId: eid, ordreNaissance: i })) },
          },
        });
        unionsCreees++;
      }

      return { personnesCreees: idMap.size, unionsCreees };
    });

    res.status(201).json(result);

    logActivity({
      familleId,
      userId: req.user!.id,
      action: 'import_gedcom',
      targetType: 'import',
      details: result,
    });
  } catch (err) {
    logger.error({ err }, '[import gedcom] échec — transaction annulée, base inchangée');
    res.status(500).json({ error: "Erreur lors de l'import — aucune donnée n'a été modifiée." });
  }
});

export default router;
