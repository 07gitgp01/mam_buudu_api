import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

import { generateToken, generateViewonlyToken } from '../middleware/auth';

describe('generateToken', () => {
  it('produit un token décodable contenant userId/email/familleId', () => {
    const token = generateToken('u1', 'a@a.com', 'f1');
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    expect(decoded.userId).toBe('u1');
    expect(decoded.email).toBe('a@a.com');
    expect(decoded.familleId).toBe('f1');
    expect(decoded.isViewonly).toBeUndefined();
  });
});

describe('generateViewonlyToken', () => {
  it('produit un token marqué isViewonly=true', () => {
    const token = generateViewonlyToken('f1');
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    expect(decoded.familleId).toBe('f1');
    expect(decoded.isViewonly).toBe(true);
    expect(decoded.userId).toBe('viewonly');
  });
});
