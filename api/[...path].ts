import { VercelRequest, VercelResponse } from '@vercel/node';
import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "../src/config/env";
import eventsRoutes from "../src/routes/events.routes";
import adminRoutes from "../src/routes/admin.routes";

let app: any = null;

async function buildServer() {
  if (app) return app;
  
  const fastify = Fastify({ 
    logger: process.env.NODE_ENV === 'development',
    trustProxy: true 
  });

  await fastify.register(cors, {
    origin: [
      "http://localhost:3000", 
      "http://127.0.0.1:3000", 
      "https://nexus-frontend-pi-ten.vercel.app",
      /\.vercel\.app$/
    ],
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  fastify.get("/", async () => ({ message: "Nexus Events Service 📅" }));
  fastify.get("/health", async () => ({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    service: "events"
  }));

  await fastify.register(eventsRoutes);
  await fastify.register(adminRoutes);

  app = fastify;
  return fastify;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const server = await buildServer();
    await server.ready();
    server.server.emit('request', req, res);
  } catch (error) {
    console.error('Events service error:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
}
