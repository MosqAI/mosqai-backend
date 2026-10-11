import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Role } from '../generated/prisma/client.js';

export interface AuthUser {
  id: string;
  role: Role;
}

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** Skips authentication (health, login, refresh). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restricts a route to the given roles. Without it any signed-in user passes. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const AUTHORITY_ROLES: Role[] = [
  'AUTHORITY_VIEWER',
  'AUTHORITY_ADMIN',
  'ADMIN',
];

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest().user,
);
