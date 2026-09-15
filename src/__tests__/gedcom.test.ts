import { parseGedcom, GedcomParseError } from '../lib/gedcom';

const SAMPLE = `0 HEAD
1 SOUR TestTool
0 @I1@ INDI
1 NAME Amadou /Diallo/
1 SEX M
1 BIRT
2 DATE 12 JAN 1950
2 PLAC Conakry
0 @I2@ INDI
1 NAME Fatoumata /Traore/
1 SEX F
1 BIRT
2 DATE 1955
0 @I3@ INDI
1 NAME Ibrahim /Diallo/
1 SEX M
1 BIRT
2 DATE 1978
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 TRLR
`;

describe('parseGedcom', () => {
  it('extrait les individus avec noms/sexe/dates', () => {
    const doc = parseGedcom(SAMPLE);
    expect(doc.individus).toHaveLength(3);

    const amadou = doc.individus.find(i => i.gedcomId === 'I1');
    expect(amadou).toMatchObject({
      prenoms: 'Amadou',
      nomNaissance: 'Diallo',
      sexe: 'M',
      dateNaissance: '1950-01-12',
      lieuNaissance: 'Conakry',
    });

    const fatoumata = doc.individus.find(i => i.gedcomId === 'I2');
    expect(fatoumata?.dateNaissance).toBe('1955');
  });

  it('extrait les familles avec conjoints et enfants', () => {
    const doc = parseGedcom(SAMPLE);
    expect(doc.familles).toHaveLength(1);
    expect(doc.familles[0]).toMatchObject({
      husbandId: 'I1',
      wifeId: 'I2',
      childrenIds: ['I3'],
    });
  });

  it('rejette un fichier sans aucun individu', () => {
    expect(() => parseGedcom('0 HEAD\n0 TRLR\n')).toThrow(GedcomParseError);
  });

  it('rejette une famille référençant un individu inconnu', () => {
    const broken = `0 @I1@ INDI
1 NAME Seul /Personne/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I99@
0 TRLR
`;
    expect(() => parseGedcom(broken)).toThrow(GedcomParseError);
  });

  it('gère une date approximative (ABT) en ne gardant que l\'année', () => {
    const doc = parseGedcom(`0 @I1@ INDI
1 NAME X /Y/
1 BIRT
2 DATE ABT 1900
0 TRLR
`);
    expect(doc.individus[0].dateNaissance).toBe('1900');
  });
});
