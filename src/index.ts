import fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import eventRoutes from "./routes/events.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import { initializeSocketManager } from "./websocket/socketManager.js";
import cache from "./utils/cache.js";
import { prisma } from "./db.js";

const app = fastify().withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.register(cors, {
  origin: ["http://localhost:3000", "http://127.0.0.1:3000", "https://nexus-frontend-pi-ten.vercel.app"],
  credentials: true,
  allowedHeaders: ["Authorization", "Content-Type"],
  exposedHeaders: ["Content-Disposition"],
});

app.register(swagger, {
  openapi: {
    openapi: "3.0.0",
    info: {
      title: "Event Service API",
      description: "API for managing events with real-time notifications",
      version: "1.0.0",
    },
    servers: [
      {
        url: "http://localhost:4003",
        description: "Development server",
      },
    ],
  },
});

app.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "full",
    deepLinking: false,
  },
  uiHooks: {
    onRequest: function (request, reply, next) {
      next();
    },
    preHandler: function (request, reply, next) {
      next();
    },
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
  transformSpecification: (swaggerObject, request, reply) => {
    return swaggerObject;
  },
  transformSpecificationClone: true,
});

app.register(eventRoutes);
app.register(adminRoutes);

app.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

const start = async () => {
  try {
    console.log("🔄 Starting Event Service...");
    console.log(`📊 Environment: ${env.NODE_ENV}`);
    console.log(`🔗 Database URL: ${env.DATABASE_URL ? 'Connected' : 'Missing'}`);
    
    // Test database connection
    console.log("🔄 Testing database connection...");
    await prisma.$connect();
    console.log("✅ Database connected successfully");

    // Initialize Redis cache (optional)
    console.log("🔄 Initializing cache...");
    await cache.connect();

    // Start the HTTP server
    console.log(`🔄 Starting HTTP server on port ${env.PORT}...`);
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    console.log(`🚀 Event service running on port ${env.PORT}`);

    // Initialize Socket.IO with the HTTP server
    console.log("🔄 Initializing Socket.IO...");
    const socketManager = initializeSocketManager(app.server);
    console.log("✅ Socket.IO initialized for real-time notifications");

  } catch (err) {
    console.error("❌ Failed to start Event Service:", err);
    app.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await cache.disconnect();
  process.exit(0);
});

start();
