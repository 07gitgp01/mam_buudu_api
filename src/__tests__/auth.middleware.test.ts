import { Response, NextFunction } from 'express';
import { requireEdit, requireManage } from '../middleware/auth';
import { AuthRequest } from '../types';

function makeReq(user: AuthRequest['user']): AuthRequest {
  return { user } as AuthRequest;
}

function makeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = jest.fn().mockImplementation(function (this: typeof res, code: number) {
    this.statusCode = code;
    return this as Response;
  });
  res.json = jest.fn().mockImplementation(function (this: typeof res, body: unknown) {
    this.body = body;
    return this as Response;
  });
  return res as Response & { statusCode?: number; body?: unknown };
}

describe('requireEdit', () => {
  it('bloque un token viewonly', () => {
    const req = makeReq({ id: 'viewonly', email: null, familleId: 'f1', isViewonly: true });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    requireEdit(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("laisse passer un membre normal (rôle 'membre')", () => {
    const req = makeReq({ id: 'u1', email: 'a@a.com', familleId: 'f1', role: 'membre' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    requireEdit(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('laisse passer un gestionnaire', () => {
    const req = makeReq({ id: 'u1', email: 'a@a.com', familleId: 'f1', role: 'gestionnaire' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    requireEdit(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

describe('requireManage', () => {
  it('bloque un token viewonly', () => {
    const req = makeReq({ id: 'viewonly', email: null, familleId: 'f1', isViewonly: true });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    requireManage(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("bloque un membre simple (rôle 'membre')", () => {
    const req = makeReq({ id: 'u1', email: 'a@a.com', familleId: 'f1', role: 'membre' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    requireManage(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('laisse passer un gestionnaire', () => {
    const req = makeReq({ id: 'u1', email: 'a@a.com', familleId: 'f1', role: 'gestionnaire' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    requireManage(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('laisse passer un admin', () => {
    const req = makeReq({ id: 'u1', email: 'a@a.com', familleId: 'f1', role: 'admin' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    requireManage(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
