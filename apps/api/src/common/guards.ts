import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { UserRole } from '@prisma/client';

import { IS_PUBLIC_KEY, ROLES_KEY, type AuthenticatedUser } from './decorators';

/**
 * Global authentication guard.
 *
 * Registered app-wide so endpoints are protected **by default** and must opt
 * out with `@Public()`. The inverse — protecting each route individually — is
 * one forgotten decorator away from an open endpoint, and that mistake is
 * invisible in review.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

/** Role-based access control. Runs after JwtAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!user) throw new ForbiddenException('Authentication required');

    // ADMIN is a superset of every other role — no need to list it everywhere.
    if (user.role === 'ADMIN') return true;

    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        `This endpoint requires one of: ${required.join(', ')}. Your role is ${user.role}.`,
      );
    }
    return true;
  }
}
