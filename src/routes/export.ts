import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(requireAuth);

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function gedcomDate(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const day   = parseInt(parts[2], 10);
    const month = MONTHS[parseInt(parts[1], 10) - 1] ?? '';
    return `${day} ${month} ${parts[0]}`;
  }
  if (parts.length === 2) {
    const month = MONTHS[parseInt(parts[1], 10) - 1] ?? '';
    return `${month} ${parts[0]}`;
  }
  return parts[0];
}

// Fragmente les longues notes en lignes CONT (max 248 chars par ligne GEDCOM)
function gedcomNote(text: string, level: number): string[] {
  const lines: string[] = [];
  const chunks = text.split('\n');
  let first = true;
  for (const chunk of chunks) {
    if (first) {
      lines.push(`${level} NOTE ${chunk}`);
      first = false;
    } else {
      lines.push(`${level + 1} CONT ${chunk}`);
    }
  }
  return lines;
}

// ── GET /api/export/gedcom ────────────────────────────────────────────────────
router.get('/gedcom', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const familleId = req.user!.familleId;

    const [famille, personnes, unions] = await Promise.all([
      prisma.famille.findUnique({ where: { id: familleId } }),
      prisma.personne.findMany({ where: { familleId }, orderBy: { createdAt: 'asc' } }),
      prisma.union.findMany({
        where: { familleId },
        include: {
          participants: true,
          filiations:   true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Index numérique pour les IDs GEDCOM (@I1@, @F1@…)
    const personneIdx = new Map<string, number>();
    personnes.forEach((p, i) => personneIdx.set(p.id, i + 1));

    const unionIdx = new Map<string, number>();
    unions.forEach((u, i) => unionIdx.set(u.id, i + 1));

    // Pré-calcul des liens FAMS / FAMC pour chaque individu
    const fams = new Map<string, number[]>(); // personneId → [unionIdx…] (époux/épouse)
    const famc = new Map<string, number[]>(); // personneId → [unionIdx…] (enfant)

    for (const u of unions) {
      const fi = unionIdx.get(u.id)!;
      for (const p of u.participants) {
        const list = fams.get(p.personneId) ?? [];
        list.push(fi);
        fams.set(p.personneId, list);
      }
      for (const f of u.filiations) {
        const list = famc.get(f.enfantId) ?? [];
        list.push(fi);
        famc.set(f.enfantId, list);
      }
    }

    const lines: string[] = [];
    const now = new Date();
    const gedNow = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

    // ── En-tête ──────────────────────────────────────────
    lines.push('0 HEAD');
    lines.push('1 SOUR Mam Buudu');
    lines.push('2 NAME Mam Buudu Genealogy App');
    lines.push('2 VERS 1.0');
    lines.push('1 DATE ' + gedNow);
    lines.push('1 FILE ' + (famille?.nom ?? 'famille') + '.ged');
    lines.push('1 GEDC');
    lines.push('2 VERS 5.5.1');
    lines.push('2 FORM LINEAGE-LINKED');
    lines.push('1 CHAR UTF-8');
    if (famille) lines.push(`1 NOTE Arbre généalogique de la famille ${famille.nom} exporté depuis Mam Buudu`);

    // ── Individus ─────────────────────────────────────────
    for (const p of personnes) {
      const ii = personneIdx.get(p.id)!;
      lines.push(`0 @I${ii}@ INDI`);

      const nom     = p.nomUsage ?? p.nomNaissance ?? '';
      const prenoms = p.prenoms ?? '';
      lines.push(`1 NAME ${prenoms} /${nom}/`);
      if (prenoms) lines.push(`2 GIVN ${prenoms}`);
      if (nom)     lines.push(`2 SURN ${nom}`);

      if (p.sexe === 'M')     lines.push('1 SEX M');
      else if (p.sexe === 'F') lines.push('1 SEX F');

      // Naissance
      if (p.dateNaissance || p.lieuNaissance) {
        lines.push('1 BIRT');
        if (p.dateNaissance) lines.push(`2 DATE ${gedcomDate(p.dateNaissance)}`);
        if (p.lieuNaissance) lines.push(`2 PLAC ${p.lieuNaissance}`);
      }

      // Décès
      if (p.dateDeces || p.lieuDeces) {
        lines.push('1 DEAT Y');
        if (p.dateDeces) lines.push(`2 DATE ${gedcomDate(p.dateDeces)}`);
        if (p.lieuDeces) lines.push(`2 PLAC ${p.lieuDeces}`);
      }

      // Liens familles
      for (const fi of fams.get(p.id) ?? []) lines.push(`1 FAMS @F${fi}@`);
      for (const fi of famc.get(p.id) ?? []) lines.push(`1 FAMC @F${fi}@`);

      // Notes / biographie
      if (p.biographie) lines.push(...gedcomNote(p.biographie, 1));
      if (p.notes)      lines.push(...gedcomNote(`Notes: ${p.notes}`, 1));
    }

    // ── Familles (unions) ─────────────────────────────────
    for (const u of unions) {
      const fi = unionIdx.get(u.id)!;
      lines.push(`0 @F${fi}@ FAM`);

      // Conjoints — mari en premier si sexe connu
      const sorted = [...u.participants].sort((a, b) => {
        const pa = personnes.find(x => x.id === a.personneId);
        const pb = personnes.find(x => x.id === b.personneId);
        const sa = pa?.sexe ?? '';
        const sb = pb?.sexe ?? '';
        return sa === 'M' ? -1 : sb === 'M' ? 1 : 0;
      });

      for (const part of sorted) {
        const pi    = personneIdx.get(part.personneId);
        const pers  = personnes.find(x => x.id === part.personneId);
        const tag   = pers?.sexe === 'F' ? 'WIFE' : 'HUSB';
        if (pi) lines.push(`1 ${tag} @I${pi}@`);
      }

      // Enfants
      for (const f of u.filiations) {
        const ci = personneIdx.get(f.enfantId);
        if (ci) lines.push(`1 CHIL @I${ci}@`);
      }

      // Mariage
      if (u.dateDebut || u.lieuDebut || u.type) {
        const tag = u.type === 'divorce' ? 'DIV' : 'MARR';
        lines.push(`1 ${tag}`);
        if (u.dateDebut) lines.push(`2 DATE ${gedcomDate(u.dateDebut)}`);
        if (u.lieuDebut) lines.push(`2 PLAC ${u.lieuDebut}`);
      }

      if (u.notes) lines.push(...gedcomNote(u.notes, 1));
    }

    lines.push('0 TRLR');

    const content  = lines.join('\r\n') + '\r\n';
    const filename = `${(famille?.nom ?? 'famille').replace(/\s+/g, '_')}_mam_buudu.ged`;

    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (err) {
    console.error('[export] gedcom error:', err);
    res.status(500).json({ error: 'Erreur lors de la génération du fichier GEDCOM' });
  }
});

export default router;
