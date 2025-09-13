import type { FastifyRequest } from "fastify";
import { prisma } from "../db.js";

export interface AuditLogData {
  adminId: string;
  adminName: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValues?: any;
  newValues?: any;
  reason?: string;
  collegeId?: string;
  metadata?: Record<string, any>;
}

export class AuditLogger {
  /**
   * Log a general admin action
   */
  static async log(data: AuditLogData, request?: FastifyRequest): Promise<void> {
    try {
      const ipAddress = this.getClientIP(request);
      const userAgent = request?.headers['user-agent'] || 'Unknown';

      await prisma.adminAuditLog.create({
        data: {
          adminId: data.adminId,
          adminName: data.adminName,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          oldValues: data.oldValues ? JSON.stringify(data.oldValues) : null,
          newValues: data.newValues ? JSON.stringify(data.newValues) : null,
          reason: data.reason || null,
          collegeId: data.collegeId || null,
          ipAddress,
          userAgent,
          metadata: data.metadata ? JSON.stringify(data.metadata) : null,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      console.error('Failed to log audit entry:', error);
      // Don't throw - audit logging shouldn't break the main operation
    }
  }

  /**
   * Log event moderation action
   */
  static async logEventModeration(
    adminId: string,
    adminName: string,
    eventId: string,
    oldEvent: any,
    newEvent: any,
    action: string,
    reason?: string,
    request?: FastifyRequest
  ): Promise<void> {
    await this.log({
      adminId,
      adminName,
      action: `MODERATE_EVENT_${action}`,
      entityType: 'EVENT',
      entityId: eventId,
      oldValues: {
        moderationStatus: oldEvent.moderationStatus,
        progressStatus: oldEvent.progressStatus,
        archivedAt: oldEvent.archivedAt,
      },
      newValues: {
        moderationStatus: newEvent.moderationStatus,
        progressStatus: newEvent.progressStatus,
        archivedAt: newEvent.archivedAt,
      },
      reason,
      collegeId: oldEvent.collegeId,
      metadata: {
        eventTitle: oldEvent.title,
        eventType: oldEvent.type,
        authorId: oldEvent.authorId,
        authorName: oldEvent.authorName,
      },
    }, request);
  }

  /**
   * Log bulk operation
   */
  static async logBulkOperation(
    adminId: string,
    adminName: string,
    action: string,
    entityType: string,
    entityIds: string[],
    changes: any,
    reason?: string,
    collegeId?: string,
    request?: FastifyRequest
  ): Promise<void> {
    await this.log({
      adminId,
      adminName,
      action: `BULK_${action}`,
      entityType,
      entityId: entityIds.join(','),
      newValues: changes,
      reason,
      collegeId,
      metadata: {
        entityCount: entityIds.length,
        entityIds: entityIds.slice(0, 10), // Store first 10 IDs to avoid huge logs
      },
    }, request);
  }

  /**
   * Log event deletion
   */
  static async logEventDeletion(
    adminId: string,
    adminName: string,
    eventId: string,
    eventData: any,
    reason?: string,
    request?: FastifyRequest
  ): Promise<void> {
    await this.log({
      adminId,
      adminName,
      action: 'DELETE_EVENT',
      entityType: 'EVENT',
      entityId: eventId,
      oldValues: eventData,
      reason,
      collegeId: eventData.collegeId,
      metadata: {
        eventTitle: eventData.title,
        eventType: eventData.type,
        authorId: eventData.authorId,
        authorName: eventData.authorName,
        registrationCount: eventData.registrations?.length || 0,
      },
    }, request);
  }

  /**
   * Log approval flow actions
   */
  static async logApprovalAction(
    adminId: string,
    adminName: string,
    eventId: string,
    action: string,
    flowData: any,
    reason?: string,
    request?: FastifyRequest
  ): Promise<void> {
    await this.log({
      adminId,
      adminName,
      action: `APPROVAL_${action}`,
      entityType: 'EVENT_APPROVAL_FLOW',
      entityId: eventId,
      newValues: flowData,
      reason,
      collegeId: flowData.event?.collegeId,
      metadata: {
        assignedTo: flowData.assignedTo,
        assignedToName: flowData.assignedToName,
        isEscalated: flowData.isEscalated,
        mentorAssigned: flowData.mentorAssigned,
      },
    }, request);
  }

  /**
   * Extract client IP address from request
   */
  private static getClientIP(request?: FastifyRequest): string {
    if (!request) return 'Unknown';

    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      return Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    }

    const realIP = request.headers['x-real-ip'];
    if (realIP) {
      return Array.isArray(realIP) ? realIP[0] : realIP;
    }

    return request.ip || 'Unknown';
  }
}
