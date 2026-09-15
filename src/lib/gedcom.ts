// Parseur GEDCOM minimal, volontairement limité aux champs que Mam Buudu modélise :
// individus (nom/prénoms/sexe/naissance/décès) et familles (conjoints + enfants).
// N'importe pas les sources, notes, médias ou autres extensions GEDCOM.

export interface GedcomIndividu {
  gedcomId: string;
  prenoms: string | null;
  nomNaissance: string | null;
  sexe: 'M' | 'F' | 'autre' | null;
  dateNaissance: string | null;
  lieuNaissance: string | null;
  dateDeces: string | null;
  lieuDeces: string | null;
}

export interface GedcomFamille {
  gedcomId: string;
  husbandId: string | null;
  wifeId: string | null;
  childrenIds: string[];
}

export interface GedcomDocument {
  individus: GedcomIndividu[];
  familles: GedcomFamille[];
}

const MOIS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

// "12 JAN 1950" | "JAN 1950" | "1950" | "ABT 1950" | "BET 1948 AND 1950" → YYYY | YYYY-MM | YYYY-MM-DD
function parseGedcomDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^(ABT|EST|CAL|BEF|AFT)\s+/i, '').split(/\s+AND\s+/i)[0].trim();
  const match = cleaned.match(/^(?:(\d{1,2})\s+)?(?:([A-Z]{3})\s+)?(\d{3,4})$/i);
  if (!match) {
    const yearOnly = cleaned.match(/\d{3,4}/);
    return yearOnly ? yearOnly[0] : null;
  }
  const [, day, mon, year] = match;
  const moisNum = mon ? MOIS[mon.toUpperCase()] : undefined;
  if (day && moisNum) return `${year}-${moisNum}-${day.padStart(2, '0')}`;
  if (moisNum) return `${year}-${moisNum}`;
  return year;
}

// "Prénom(s) /Nom de naissance/" → { prenoms, nomNaissance }
function parseGedcomName(raw: string | undefined): { prenoms: string | null; nomNaissance: string | null } {
  if (!raw) return { prenoms: null, nomNaissance: null };
  const match = raw.match(/^([^/]*)\/([^/]*)\/?/);
  if (!match) return { prenoms: raw.trim() || null, nomNaissance: null };
  const prenoms = match[1].trim() || null;
  const nomNaissance = match[2].trim() || null;
  return { prenoms, nomNaissance };
}

interface RawLine { level: number; tag: string; xref: string | null; value: string | null; }

function tokenize(text: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(@[^@]+@\s+)?(\S+)(?:\s(.*))?$/);
    if (!m) continue;
    const [, levelStr, xrefRaw, tag, value] = m;
    lines.push({
      level: parseInt(levelStr, 10),
      xref: xrefRaw ? xrefRaw.trim().replace(/@/g, '') : null,
      tag: tag.toUpperCase(),
      value: value ?? null,
    });
  }
  return lines;
}

export class GedcomParseError extends Error {}

export function parseGedcom(text: string): GedcomDocument {
  const lines = tokenize(text);
  const individus: GedcomIndividu[] = [];
  const familles: GedcomFamille[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.level === 0 && line.tag === 'INDI' && line.xref) {
      const gedcomId = line.xref;
      let nameRaw: string | undefined;
      let sexeRaw: string | undefined;
      let dateNaissance: string | null = null;
      let lieuNaissance: string | null = null;
      let dateDeces: string | null = null;
      let lieuDeces: string | null = null;

      let j = i + 1;
      let context: 'BIRT' | 'DEAT' | null = null;
      while (j < lines.length && lines[j].level > 0) {
        const l = lines[j];
        if (l.level === 1) {
          if (l.tag === 'NAME') nameRaw = l.value ?? undefined;
          else if (l.tag === 'SEX') sexeRaw = l.value ?? undefined;
          else if (l.tag === 'BIRT') context = 'BIRT';
          else if (l.tag === 'DEAT') context = 'DEAT';
          else context = null;
        } else if (l.level === 2 && context) {
          if (l.tag === 'DATE') {
            const parsed = parseGedcomDate(l.value ?? undefined);
            if (context === 'BIRT') dateNaissance = parsed; else dateDeces = parsed;
          } else if (l.tag === 'PLAC') {
            if (context === 'BIRT') lieuNaissance = l.value ?? null; else lieuDeces = l.value ?? null;
          }
        }
        j++;
      }

      const { prenoms, nomNaissance } = parseGedcomName(nameRaw);
      const sexe = sexeRaw === 'M' ? 'M' : sexeRaw === 'F' ? 'F' : sexeRaw ? 'autre' : null;

      individus.push({ gedcomId, prenoms, nomNaissance, sexe, dateNaissance, lieuNaissance, dateDeces, lieuDeces });
      i = j;
      continue;
    }

    if (line.level === 0 && line.tag === 'FAM' && line.xref) {
      const gedcomId = line.xref;
      let husbandId: string | null = null;
      let wifeId: string | null = null;
      const childrenIds: string[] = [];

      let j = i + 1;
      while (j < lines.length && lines[j].level > 0) {
        const l = lines[j];
        if (l.level === 1) {
          const xref = l.value ? l.value.replace(/@/g, '') : null;
          if (l.tag === 'HUSB' && xref) husbandId = xref;
          else if (l.tag === 'WIFE' && xref) wifeId = xref;
          else if (l.tag === 'CHIL' && xref) childrenIds.push(xref);
        }
        j++;
      }

      familles.push({ gedcomId, husbandId, wifeId, childrenIds });
      i = j;
      continue;
    }

    i++;
  }

  if (individus.length === 0) {
    throw new GedcomParseError('Aucun individu (INDI) trouvé dans ce fichier GEDCOM.');
  }

  // Vérifie que toutes les références HUSB/WIFE/CHIL pointent vers un individu connu —
  // un fichier avec des références cassées est rejeté en bloc plutôt qu'importé partiellement.
  const knownIds = new Set(individus.map(i => i.gedcomId));
  for (const fam of familles) {
    for (const ref of [fam.husbandId, fam.wifeId, ...fam.childrenIds]) {
      if (ref && !knownIds.has(ref)) {
        throw new GedcomParseError(`Référence brisée dans le fichier : la famille ${fam.gedcomId} pointe vers un individu inconnu (${ref}).`);
      }
    }
  }

  return { individus, familles };
}
