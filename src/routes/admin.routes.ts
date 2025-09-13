import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma, Prisma } from "../db.js";
import { requireHeadAdmin, canAccessCollege, getCollegeFilter, AdminAuthPayload } from "../middlewares/adminAuth.js";
import { AuditLogger } from "../utils/auditLogger.js";
import type { EventType, EventMode, ModerationStatus } from "@prisma/client";

// Validation schemas
const eventFiltersSchema = z.object({
  search: z.string().optional(),
  moderationStatus: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED"]).optional(),
  type: z.enum(["WORKSHOP", "SEMINAR", "HACKATHON", "MEETUP"]).optional(),
  mode: z.enum(["ONLINE", "ONSITE", "HYBRID"]).optional(),
  authorDepartment: z.string().optional(),
  tags: z.array(z.string()).optional(),
  startAfter: z.string().datetime().optional(),
  startBefore: z.string().datetime().optional(),
  capacityMin: z.union([z.number(), z.string()]).transform(val => {
    const num = typeof val === 'string' ? parseInt(val, 10) : val;
    return isNaN(num) ? undefined : Math.max(0, num);
  }).optional(),
  capacityMax: z.union([z.number(), z.string()]).transform(val => {
    const num = typeof val === 'string' ? parseInt(val, 10) : val;
    return isNaN(num) ? undefined : Math.max(0, num);
  }).optional(),
  page: z.union([z.number(), z.string()]).transform(val => {
    const num = typeof val === 'string' ? parseInt(val, 10) : val;
    return isNaN(num) ? 1 : Math.max(1, num);
  }).default(1),
  limit: z.union([z.number(), z.string()]).transform(val => {
    const num = typeof val === 'string' ? parseInt(val, 10) : val;
    return isNaN(num) ? 20 : Math.min(100, Math.max(1, num));
  }).default(20),
  sortBy: z.enum(["createdAt", "startAt", "title", "registrationCount", "authorName"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc")
});

const moderateEventSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "ASSIGN_MENTOR", "ESCALATE"]),
  reason: z.string().optional(),
  mentorId: z.string().optional(),
  mentorName: z.string().optional(),
  moderationStatus: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED"]).optional()
});

const bulkModerationSchema = z.object({
  eventIds: z.array(z.string()).min(1).max(50),
  action: z.enum(["APPROVE", "REJECT", "ARCHIVE"]),
  reason: z.string().optional()
});

async function adminRoutes(app: FastifyInstance) {
  
  // GET /v1/admin/events - List events with advanced filtering
  app.get('/v1/admin/events', async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilter = getCollegeFilter(adminAuth);
      
      // Manual query parameter parsing with validation
      const query = request.query as any;
      const filters = {
        search: query.search || undefined,
        moderationStatus: query.moderationStatus || undefined,
        type: query.type || undefined,
        mode: query.mode || undefined,
        authorDepartment: query.authorDepartment || undefined,
        tags: query.tags ? (Array.isArray(query.tags) ? query.tags : [query.tags]) : undefined,
        startAfter: query.startAfter || undefined,
        startBefore: query.startBefore || undefined,
        capacityMin: query.capacityMin ? parseInt(query.capacityMin as string, 10) : undefined,
        capacityMax: query.capacityMax ? parseInt(query.capacityMax as string, 10) : undefined,
        page: query.page ? Math.max(1, parseInt(query.page as string, 10)) : 1,
        limit: query.limit ? Math.min(100, Math.max(1, parseInt(query.limit as string, 10))) : 20,
        sortBy: query.sortBy || 'createdAt',
        sortOrder: query.sortOrder || 'desc'
      };

      // Build where clause
      const whereClause: any = {};
      if (collegeFilter) {
        whereClause.collegeId = collegeFilter;
      }

      if (filters.search) {
        whereClause.OR = [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
          { authorName: { contains: filters.search, mode: 'insensitive' } },
          { tags: { hasSome: [filters.search] } }
        ];
      }

      if (filters.moderationStatus) whereClause.moderationStatus = filters.moderationStatus;
      if (filters.type) whereClause.type = filters.type;
      if (filters.mode) whereClause.mode = filters.mode;
      if (filters.authorDepartment) whereClause.authorDepartment = filters.authorDepartment;
      if (filters.tags && filters.tags.length > 0) whereClause.tags = { hasSome: filters.tags };

      if (filters.startAfter || filters.startBefore) {
        whereClause.startAt = {};
        if (filters.startAfter) whereClause.startAt.gte = new Date(filters.startAfter);
        if (filters.startBefore) whereClause.startAt.lte = new Date(filters.startBefore);
      }

      if (filters.capacityMin !== undefined || filters.capacityMax !== undefined) {
        whereClause.capacity = {};
        if (filters.capacityMin !== undefined) whereClause.capacity.gte = filters.capacityMin;
        if (filters.capacityMax !== undefined) whereClause.capacity.lte = filters.capacityMax;
      }

      const offset = (filters.page - 1) * filters.limit;
      let orderBy: any = {};
      if (filters.sortBy === 'registrationCount') {
        orderBy = { registrations: { _count: filters.sortOrder } };
      } else {
        orderBy[filters.sortBy] = filters.sortOrder;
      }

      const [events, totalCount] = await Promise.all([
        prisma.event.findMany({
          where: whereClause,
          include: {
            registrations: { select: { id: true } },
            approvalFlow: true
          },
          orderBy,
          skip: offset,
          take: filters.limit
        }),
        prisma.event.count({ where: whereClause })
      ]);

      // Get statistics
      const stats = await prisma.event.groupBy({
        by: ['moderationStatus', 'type'],
        where: collegeFilter ? { collegeId: collegeFilter } : {},
        _count: true
      });

      const statsObj = {
        total: totalCount,
        pending: 0,
        approved: 0,
        rejected: 0,
        workshop: 0,
        seminar: 0,
        hackathon: 0,
        meetup: 0
      };

      stats.forEach(stat => {
        if (stat.moderationStatus === 'PENDING_REVIEW') statsObj.pending += stat._count;
        if (stat.moderationStatus === 'APPROVED') statsObj.approved += stat._count;
        if (stat.moderationStatus === 'REJECTED') statsObj.rejected += stat._count;
        if (stat.type === 'WORKSHOP') statsObj.workshop += stat._count;
        if (stat.type === 'SEMINAR') statsObj.seminar += stat._count;
        if (stat.type === 'HACKATHON') statsObj.hackathon += stat._count;
        if (stat.type === 'MEETUP') statsObj.meetup += stat._count;
      });

      const eventsWithCount = events.map(event => ({
        ...event,
        registrationCount: event.registrations.length,
        registrations: undefined
      }));

      return reply.send({
        success: true,
        data: {
          events: eventsWithCount,
          pagination: {
            page: filters.page,
            limit: filters.limit,
            total: totalCount,
            totalPages: Math.ceil(totalCount / filters.limit)
          },
          stats: statsObj
        }
      });

    } catch (error: any) {
      console.error('[ADMIN EVENTS] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch events',
        message: error.message
      });
    }
  });

  // GET /v1/admin/events/:id - Get event details with registrations
  app.get('/v1/admin/events/:id', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const { id } = request.params as { id: string };

      const event = await prisma.event.findUnique({
        where: { id },
        include: {
          registrations: {
            orderBy: { joinedAt: 'desc' }
          },
          approvalFlow: true,
          waitlist: {
            orderBy: { priority: 'desc' }
          }
        }
      });

      if (!event) {
        return reply.status(404).send({
          success: false,
          error: 'Event not found'
        });
      }

      if (!canAccessCollege(adminAuth, event.collegeId)) {
        return reply.status(403).send({
          success: false,
          error: 'Access denied to this event'
        });
      }

      return reply.send({
        success: true,
        data: { event }
      });

    } catch (error: any) {
      console.error('[ADMIN EVENT DETAILS] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch event details',
        message: error.message
      });
    }
  });

  // PATCH /v1/admin/events/:id/moderate - Moderate single event
  app.patch('/v1/admin/events/:id/moderate', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      },
      body: moderateEventSchema
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const { id } = request.params as { id: string };
      const { action, reason, mentorId, mentorName, moderationStatus } = moderateEventSchema.parse(request.body);

      const currentEvent = await prisma.event.findUnique({
        where: { id },
        include: { approvalFlow: true }
      });

      if (!currentEvent) {
        return reply.status(404).send({
          success: false,
          error: 'Event not found'
        });
      }

      if (!canAccessCollege(adminAuth, currentEvent.collegeId)) {
        return reply.status(403).send({
          success: false,
          error: 'Access denied to this event'
        });
      }

      let updateData: any = {};
      let flowUpdateData: any = {};

      switch (action) {
        case 'APPROVE':
          updateData.moderationStatus = 'APPROVED';
          if (mentorId) {
            updateData.monitorId = mentorId;
            updateData.monitorName = mentorName;
          }
          flowUpdateData = {
            approvedAt: new Date(),
            approvedBy: adminAuth.sub,
            approvedByName: adminAuth.displayName,
            mentorAssigned: mentorId,
            mentorName: mentorName
          };
          break;
        case 'REJECT':
          updateData.moderationStatus = 'REJECTED';
          flowUpdateData = {
            rejectedAt: new Date(),
            rejectedBy: adminAuth.sub,
            rejectedByName: adminAuth.displayName,
            rejectionReason: reason
          };
          break;
        case 'ASSIGN_MENTOR':
          if (mentorId) {
            updateData.monitorId = mentorId;
            updateData.monitorName = mentorName;
            flowUpdateData = {
              mentorAssigned: mentorId,
              mentorName: mentorName
            };
          }
          break;
      }

      if (moderationStatus) {
        updateData.moderationStatus = moderationStatus;
      }

      const updatedEvent = await prisma.event.update({
        where: { id },
        data: updateData
      });

      if (currentEvent.approvalFlow && Object.keys(flowUpdateData).length > 0) {
        await prisma.eventApprovalFlow.update({
          where: { eventId: id },
          data: flowUpdateData
        });
      }

      await AuditLogger.logEventModeration(
        adminAuth.sub,
        adminAuth.displayName || 'Unknown Admin',
        id,
        currentEvent,
        updatedEvent,
        action,
        reason,
        request
      );

      return reply.send({
        success: true,
        data: { event: updatedEvent },
        message: `Event ${action.toLowerCase()}d successfully`
      });

    } catch (error: any) {
      console.error('[ADMIN EVENT MODERATE] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to moderate event',
        message: error.message
      });
    }
  });

  // PATCH /v1/admin/events/bulk-moderate - Bulk moderation
  app.patch('/v1/admin/events/bulk-moderate', {
    schema: {
      body: bulkModerationSchema
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const { eventIds, action, reason } = bulkModerationSchema.parse(request.body);

      const events = await prisma.event.findMany({
        where: { id: { in: eventIds } }
      });

      if (events.length === 0) {
        return reply.status(404).send({
          success: false,
          error: 'No events found'
        });
      }

      const inaccessibleEvents = events.filter(event => 
        !canAccessCollege(adminAuth, event.collegeId)
      );

      if (inaccessibleEvents.length > 0) {
        return reply.status(403).send({
          success: false,
          error: `Access denied to ${inaccessibleEvents.length} event(s)`
        });
      }

      let updateData: any = {};
      switch (action) {
        case 'APPROVE':
          updateData.moderationStatus = 'APPROVED';
          break;
        case 'REJECT':
          updateData.moderationStatus = 'REJECTED';
          break;
        case 'ARCHIVE':
          updateData.archivedAt = new Date();
          break;
      }

      const result = await prisma.event.updateMany({
        where: { id: { in: eventIds } },
        data: updateData
      });

      await AuditLogger.logBulkOperation(
        adminAuth.sub,
        adminAuth.displayName || 'Unknown Admin',
        `MODERATE_${action}`,
        'EVENT',
        eventIds,
        updateData,
        reason,
        adminAuth.collegeId,
        request
      );

      return reply.send({
        success: true,
        data: { 
          updatedCount: result.count,
          action: action.toLowerCase()
        },
        message: `${result.count} event(s) ${action.toLowerCase()}d successfully`
      });

    } catch (error: any) {
      console.error('[ADMIN BULK MODERATE] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to perform bulk moderation',
        message: error.message
      });
    }
  });

  // GET /v1/admin/events/export - Export events data
  app.get('/v1/admin/events/export', {
    schema: {
      querystring: eventFiltersSchema.extend({
        format: z.enum(['json', 'csv']).default('csv')
      })
    }
  }, async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilter = getCollegeFilter(adminAuth);
      const { format = 'csv', ...filters } = request.query as any;

      // Build where clause (reuse logic from events list)
      const whereClause: any = {};
      if (collegeFilter) {
        whereClause.collegeId = collegeFilter;
      }

      if (filters.search) {
        whereClause.OR = [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
          { authorName: { contains: filters.search, mode: 'insensitive' } }
        ];
      }

      if (filters.moderationStatus) whereClause.moderationStatus = filters.moderationStatus;
      if (filters.type) whereClause.type = filters.type;
      if (filters.mode) whereClause.mode = filters.mode;

      const events = await prisma.event.findMany({
        where: whereClause,
        include: {
          registrations: {
            select: { 
              id: true, 
              userId: true, 
              joinedAt: true 
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      const exportData = events.map(event => ({
        eventName: event.title,
        description: event.description,
        authorName: event.authorName,
        authorRole: event.authorRole,
        type: event.type,
        mode: event.mode,
        location: event.location || 'N/A',
        meetingUrl: event.meetingUrl || 'N/A',
        capacity: event.capacity || 'Unlimited',
        moderationStatus: event.moderationStatus,
        registrationCount: event.registrations.length,
        startAt: new Date(event.startAt).toLocaleString(),
        endAt: new Date(event.endAt).toLocaleString(),
        tags: event.tags.join(', '),
        createdAt: new Date(event.createdAt).toLocaleString()
      }));

      if (format === 'json') {
        return reply
          .header('Content-Disposition', 'attachment; filename="events-export.json"')
          .header('Content-Type', 'application/json')
          .send({
            success: true,
            data: exportData,
            exportedAt: new Date(),
            totalRecords: exportData.length
          });
      } else {
        // CSV format
        const headers = [
          'eventName', 'description', 'authorName', 'authorRole', 'type', 'mode',
          'location', 'capacity', 'moderationStatus', 'registrationCount',
          'startAt', 'endAt', 'tags', 'createdAt'
        ];

        const csvEscape = (v: any) => {
          if (v === null || v === undefined) return "";
          const s = String(v);
          if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
          return s;
        };

        const lines = [
          headers.join(","),
          ...exportData.map(row => headers.map(h => csvEscape((row as any)[h])).join(","))
        ];
        const csv = "\uFEFF" + lines.join("\n");

        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="events-export.csv"');
        return reply.send(csv);
      }

    } catch (error: any) {
      console.error('[ADMIN EXPORT] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to export events',
        message: error.message
      });
    }
  });

  // GET /v1/admin/events/stats - Dashboard statistics
  app.get('/v1/admin/events/stats', async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilter = getCollegeFilter(adminAuth);

      const whereClause = collegeFilter ? { collegeId: collegeFilter } : {};

      const [
        totalEvents,
        moderationStats,
        typeStats,
        recentEvents,
        registrationStats
      ] = await Promise.all([
        prisma.event.count({ where: whereClause }),
        
        prisma.event.groupBy({
          by: ['moderationStatus'],
          where: whereClause,
          _count: true
        }),
        
        prisma.event.groupBy({
          by: ['type'],
          where: whereClause,
          _count: true
        }),
        
        prisma.event.findMany({
          where: {
            ...whereClause,
            createdAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
            }
          },
          select: { id: true }
        }),
        
        prisma.eventRegistration.count({
          where: collegeFilter ? {
            event: { collegeId: collegeFilter }
          } : {}
        })
      ]);

      const stats = {
        overview: {
          totalEvents,
          recentEvents: recentEvents.length,
          totalRegistrations: registrationStats,
          lastUpdated: new Date()
        },
        moderation: moderationStats.reduce((acc, stat) => {
          acc[stat.moderationStatus.toLowerCase()] = stat._count;
          return acc;
        }, {} as any),
        types: typeStats.reduce((acc, stat) => {
          acc[stat.type.toLowerCase()] = stat._count;
          return acc;
        }, {} as any)
      };

      return reply.send({
        success: true,
        data: stats
      });

    } catch (error: any) {
      console.error('[ADMIN STATS] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch statistics',
        message: error.message
      });
    }
  });


  // Get recent event activities for dashboard
  app.get('/v1/admin/events/recent-activity', async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilter = getCollegeFilter(adminAuth);
      const limit = parseInt((request.query as any)?.limit) || 10;

      // Get recent events
      const recentEvents = await prisma.event.findMany({
        where: {
          collegeId: collegeFilter,
          archivedAt: null,
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          title: true,
          description: true,
          authorName: true,
          type: true,
          startAt: true,
          createdAt: true,
          moderationStatus: true
        }
      });

      // Convert to activity format
      const activities = recentEvents.map(event => ({
        id: `event_${event.id}`,
        type: event.moderationStatus === 'APPROVED' ? 'event_published' as const : 'event_created' as const,
        title: event.moderationStatus === 'APPROVED' ? 'Event published' : 'New event created',
        description: event.title,
        timestamp: event.createdAt.toISOString(),
        user: {
          name: event.authorName,
          avatar: undefined
        },
        metadata: {
          eventType: event.type,
          startAt: event.startAt.toISOString(),
          status: event.moderationStatus
        }
      }));

      return reply.send({
        activities
      });

    } catch (error: any) {
      console.error('[ADMIN EVENTS RECENT ACTIVITY] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch recent event activity',
        message: error.message
      });
    }
  });

  // Get dashboard statistics for events
  app.get('/v1/admin/events/dashboard-stats', async (request, reply) => {
    try {
      const adminAuth = await requireHeadAdmin(request, reply);
      const collegeFilterId = getCollegeFilter(adminAuth);

      // Date ranges for comparison
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      // Build base where clause
      const baseWhere: any = {
        archivedAt: null
      };
      if (collegeFilterId) {
        baseWhere.collegeId = collegeFilterId;
      }

      // Current period stats
      const currentWhere = {
        ...baseWhere,
        createdAt: { gte: thirtyDaysAgo }
      };

      // Previous period stats for comparison
      const previousWhere = {
        ...baseWhere,
        createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo }
      };

      // Get total events
      const [totalEvents, totalEventsPrevious] = await Promise.all([
        prisma.event.count({ where: baseWhere }),
        prisma.event.count({ where: previousWhere })
      ]);

      // Get total registrations
      const [totalRegistrations, totalRegistrationsPrevious] = await Promise.all([
        prisma.eventRegistration.count({
          where: {
            event: baseWhere
          }
        }),
        prisma.eventRegistration.count({
          where: {
            event: previousWhere
          }
        })
      ]);

      // Calculate percentage changes
      const calculateChange = (current: number, previous: number) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return Math.round(((current - previous) / previous) * 100);
      };

      const dashboardStats = {
        totalEvents,
        totalEventsChange: calculateChange(totalEvents, totalEventsPrevious),
        totalRegistrations,
        totalRegistrationsChange: calculateChange(totalRegistrations, totalRegistrationsPrevious)
      };

      return reply.send({
        success: true,
        data: dashboardStats
      });

    } catch (error: any) {
      console.error('[ADMIN EVENTS DASHBOARD STATS] Error:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch events dashboard statistics',
        message: error.message
      });
    }
  });

  // Comprehensive analytics endpoint for HEAD_ADMIN
  app.get('/v1/admin/events/analytics/comprehensive', {
    preHandler: [requireHeadAdmin]
  }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const adminPayload = await requireHeadAdmin(request, reply);
        const collegeFilter = getCollegeFilter(adminPayload);
        const { timeRange = '30d' } = request.query as { timeRange?: string };
        
        // Calculate date ranges
        const now = new Date();
        const getDaysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        
        let startDate: Date;
        switch (timeRange) {
          case '7d': startDate = getDaysAgo(7); break;
          case '30d': startDate = getDaysAgo(30); break;
          case '90d': startDate = getDaysAgo(90); break;
          case '1y': startDate = getDaysAgo(365); break;
          default: startDate = getDaysAgo(30);
        }
        
        const previousPeriodStart = new Date(startDate.getTime() - (now.getTime() - startDate.getTime()));
        
        // Event analytics
        const [
          totalEvents,
          activeEvents,
          upcomingEvents,
          pastEvents,
          eventsInPeriod,
          eventsInPreviousPeriod,
          totalRegistrations,
          pendingRegistrations,
          confirmedRegistrations,
          registrationsInPeriod,
          eventsByDepartment,
          monthlyEventTrends,
          topEventTypes,
          eventStatusDistribution
        ] = await Promise.all([
          // Basic event counts
          prisma.event.count({
            where: { ...(collegeFilter && { collegeId: collegeFilter }) }
          }),
          prisma.event.count({
            where: {
              ...(collegeFilter && { collegeId: collegeFilter }),
              moderationStatus: 'APPROVED',
              endAt: { gte: now }
            }
          }),
          prisma.event.count({
            where: {
              ...(collegeFilter && { collegeId: collegeFilter }),
              moderationStatus: 'APPROVED',
              startAt: { gte: now }
            }
          }),
          prisma.event.count({
            where: {
              ...(collegeFilter && { collegeId: collegeFilter }),
              endAt: { lt: now }
            }
          }),
          
          // Period comparisons
          prisma.event.count({
            where: {
              ...(collegeFilter && { collegeId: collegeFilter }),
              createdAt: { gte: startDate }
            }
          }),
          prisma.event.count({
            where: {
              ...(collegeFilter && { collegeId: collegeFilter }),
              createdAt: { gte: previousPeriodStart, lt: startDate }
            }
          }),
          
          // Registration analytics
          prisma.eventRegistration.count({
            where: {
              event: { ...(collegeFilter && { collegeId: collegeFilter }) }
            }
          }),
          prisma.eventRegistration.count({
            where: {
              // EventRegistration doesn't have status field, removing filter
              event: { ...(collegeFilter && { collegeId: collegeFilter }) }
            }
          }),
          prisma.eventRegistration.count({
            where: {
              // EventRegistration doesn't have status field, removing filter
              event: { ...(collegeFilter && { collegeId: collegeFilter }) }
            }
          }),
          prisma.eventRegistration.count({
            where: {
              joinedAt: { gte: startDate },
              event: { ...(collegeFilter && { collegeId: collegeFilter }) }
            }
          }),
          
          // Department statistics
          prisma.event.groupBy({
            by: ['departments'],
            where: { ...(collegeFilter && { collegeId: collegeFilter }) },
            _count: { id: true }
          }),
          
          // Monthly trends (last 12 months)
          prisma.$queryRaw`
            SELECT 
              DATE_TRUNC('month', "createdAt") as month,
              COUNT(*)::int as count,
              COUNT(CASE WHEN "moderationStatus" = 'APPROVED' THEN 1 END)::int as approved
            FROM "Event" 
            WHERE "createdAt" >= ${getDaysAgo(365)}
              ${collegeFilter ? Prisma.sql`AND "collegeId" = ${collegeFilter}` : Prisma.empty}
            GROUP BY DATE_TRUNC('month', "createdAt")
            ORDER BY month DESC
            LIMIT 12
          `,
          
          // Top event types
          prisma.event.groupBy({
            by: ['type'],
            where: {
              ...(collegeFilter && { collegeId: collegeFilter }),
              moderationStatus: 'APPROVED'
            },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: 10
          }),
          
          // Event status distribution
          prisma.event.groupBy({
            by: ['moderationStatus'],
            where: { ...(collegeFilter && { collegeId: collegeFilter }) },
            _count: { id: true }
          })
        ]);
        
        // Calculate growth percentages
        const eventGrowth = eventsInPreviousPeriod > 0 
          ? ((eventsInPeriod - eventsInPreviousPeriod) / eventsInPreviousPeriod * 100)
          : eventsInPeriod > 0 ? 100 : 0;
        
        // Format department stats
        const formattedDepartmentStats = await Promise.all(
          eventsByDepartment.map(async (dept) => {
            const registrations = await prisma.eventRegistration.count({
              where: {
                event: {
                  ...(collegeFilter && { collegeId: collegeFilter }),
                  departments: { hasSome: dept.departments }
                }
              }
            });
            
            return {
              departments: dept.departments,
              eventCount: dept._count.id,
              registrations
            };
          })
        );

        const analytics = {
          summary: {
            totalEvents,
            activeEvents,
            totalRegistrations,
            pendingRegistrations,
            eventGrowth: Math.round(eventGrowth * 100) / 100,
            registrationGrowth: registrationsInPeriod,
            timeRange
          },
          eventMetrics: {
            total: totalEvents,
            active: activeEvents,
            upcoming: upcomingEvents,
            past: pastEvents,
            newInPeriod: eventsInPeriod,
            growthRate: eventGrowth
          },
          registrationMetrics: {
            total: totalRegistrations,
            pending: pendingRegistrations,
            confirmed: confirmedRegistrations,
            newInPeriod: registrationsInPeriod,
            confirmationRate: totalRegistrations > 0 ? (confirmedRegistrations / totalRegistrations * 100) : 0
          },
          departmentStats: formattedDepartmentStats,
          trends: {
            monthly: monthlyEventTrends,
            topEventTypes: topEventTypes.map(type => ({
              eventType: type.type,
              count: type._count.id
            }))
          },
          distributions: {
            eventStatus: eventStatusDistribution.map(status => ({
              status: status.moderationStatus,
              count: status._count.id
            }))
          }
        };
        
        reply.send(analytics);
      } catch (error) {
        console.error('Error fetching event analytics:', error);
        reply.status(500).send({ error: 'Failed to fetch event analytics data' });
      }
    });
}

export default adminRoutes;
