import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // ─── CORS trên Express app gốc (trước Nest) ──────────────────────────────────
  // axios withCredentials=true cần Allow-Credentials: true trên cả OPTIONS preflight.
  const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const allowedOrigins = [
    ...(process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : []),
    ...(frontendUrl ? [frontendUrl] : []),
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ];
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && allowedOrigins.filter((o) => !o.includes('localhost')).length === 0) {
    logger.error('❌ CRITICAL SECURITY WARNING: ALLOWED_ORIGINS is not defined in production.');
  }

  const server = express();
  const apiPrefix = process.env.API_PREFIX || 'api/v1';

  // Meta ký HMAC trên byte gốc. Phải giữ raw body TRƯỚC Nest JSON parser, nếu không chữ ký luôn sai dù secret đúng.
  server.use(
    `/${apiPrefix}/cskh/webhook`,
    express.raw({ type: '*/*', limit: '5mb' }),
    (req, _res, next) => {
      const buf = req.body as Buffer;
      if (Buffer.isBuffer(buf)) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
        try {
          const text = buf.toString('utf8');
          req.body = text ? JSON.parse(text) : {};
        } catch {
          req.body = {};
        }
      }
      next();
    },
  );

  server.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (!isProduction || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          callback(null, origin);
          return;
        }
        logger.warn(`CORS blocked request from origin: ${origin}`);
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Accept',
        'Origin',
        'X-Requested-With',
        'X-CSRF-Token',
      ],
      optionsSuccessStatus: 204,
    }),
  );

  // Probe / browser mở http://localhost:PORT/ → không đi vào Nest (tránh spam 404 ERROR)
  server.get('/', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'cqa-be',
      api: `/${apiPrefix}`,
      docs: '/docs',
      health: `/${apiPrefix}/health`,
    });
  });

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    rawBody: true,
  });

  app.use(cookieParser());

  // ─── Security Headers (Helmet) ───────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: false, // Swagger docs need inline JS/CSS; disable CSP as BE is an API
      // FE khác origin (Vite :5173) cần đọc response API
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // ─── Global Prefix ───────────────────────────────────────────────────────────
  app.setGlobalPrefix(apiPrefix);

  // ─── Global Validation Pipe ───────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,           // Strip unknown properties
      forbidNonWhitelisted: true, // Throw error on unknown properties
      transform: true,           // Auto-transform payload to DTO types
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ─── Global Exception Filter ──────────────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());

  // ─── Swagger API Documentation ────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('CQA CRM Backend API')
    .setDescription('Tài liệu API dành cho hệ thống CQA CRM (Customer Quality Audit)')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Nhập JWT Token để truy cập các API cần xác thực',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  // Tự động lưu Swagger Spec ra file trong folder riêng để quản lý / đồng bộ
  const swaggerDir = path.resolve(process.cwd(), 'swagger');
  if (!fs.existsSync(swaggerDir)) {
    fs.mkdirSync(swaggerDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(swaggerDir, 'swagger-spec.json'),
    JSON.stringify(document, null, 2),
    'utf8',
  );

  // ─── Start Server ─────────────────────────────────────────────────────────────
  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`🚀 Application running on: http://localhost:${port}/${apiPrefix}`);
  logger.log(`📋 Auth endpoints: http://localhost:${port}/${apiPrefix}/auth`);
  logger.log(`📄 Swagger documentation: http://localhost:${port}/docs`);
}

bootstrap();
