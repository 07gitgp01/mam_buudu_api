import { Request } from 'express';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string | null;
    familleId: string;
    isViewonly?: boolean;
    role?: string;
  };
}

export interface SuperAdminRequest extends Request {
  superadmin?: {
    id: string;
    platformRole: string;
  };
}
