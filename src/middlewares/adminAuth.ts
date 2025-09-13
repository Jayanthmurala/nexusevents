import type { FastifyRequest, FastifyReply } from "fastify";
import { requireAuth, requireRole } from "./auth.js";
import { getUserScope } from "../clients/profile.js";

export interface AdminAuthPayload {
  sub: string;
  roles: string[];
  displayName?: string;
  collegeId?: string;
  department?: string;
}

/**
 * Middleware to require HEAD_ADMIN or SUPER_ADMIN role
 * HEAD_ADMIN can only access their own college data
 * SUPER_ADMIN can access all colleges
 */
export async function requireHeadAdmin(req: FastifyRequest, reply: FastifyReply): Promise<AdminAuthPayload> {
  const payload = await requireAuth(req);
  const roles = payload.roles || [];
  
  if (!roles.includes('HEAD_ADMIN') && !roles.includes('SUPER_ADMIN')) {
    throw new Error('Insufficient permissions. HEAD_ADMIN or SUPER_ADMIN role required.');
  }
  
  const userScope = await getUserScope(req, payload);
  
  return {
    sub: payload.sub,
    roles,
    displayName: payload.displayName || userScope.displayName || 'Unknown Admin',
    collegeId: userScope.collegeId,
    department: userScope.department,
  };
}

/**
 * Check if admin has access to specific college
 * SUPER_ADMIN can access any college
 * HEAD_ADMIN can only access their own college
 */
export function canAccessCollege(adminPayload: AdminAuthPayload, targetCollegeId?: string): boolean {
  if (adminPayload.roles.includes('SUPER_ADMIN')) {
    return true; // Super admin can access everything
  }
  
  if (adminPayload.roles.includes('HEAD_ADMIN')) {
    if (!targetCollegeId) {
      return true; // No specific college restriction
    }
    return adminPayload.collegeId === targetCollegeId;
  }
  
  return false;
}

/**
 * Get college filter for admin queries
 * Returns undefined for SUPER_ADMIN (no filter)
 * Returns collegeId for HEAD_ADMIN (scoped to their college)
 */
export function getCollegeFilter(adminPayload: AdminAuthPayload): string | undefined {
  if (adminPayload.roles.includes('SUPER_ADMIN')) {
    return undefined; // No college restriction
  }
  
  if (adminPayload.roles.includes('HEAD_ADMIN')) {
    return adminPayload.collegeId;
  }
  
  return undefined;
}
