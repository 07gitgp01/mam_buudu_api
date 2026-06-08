import { Request } from 'express';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string | null;
    familleId: string;
    isViewonly?: boolean;
  };
}

export interface SuperAdminRequest extends Request {
  superadmin?: {
    id: string;
    platformRole: string;
  };
}
