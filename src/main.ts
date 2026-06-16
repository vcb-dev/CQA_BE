import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(cookieParser());
  const logger = new Logger('Bootstrap');

  // ─── Security Headers (Helmet) ───────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: false, // Swagger docs need inline JS/CSS; disable CSP as BE is an API
    }),
  );

  // ─── Global Prefix ───────────────────────────────────────────────────────────
  const apiPrefix = process.env.API_PREFIX || 'api/v1';
  app.setGlobalPrefix(apiPrefix);

  // ─── CORS ─────────────────────────────────────────────────────────────────────
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && allowedOrigins.length === 0) {
    logger.error('❌ CRITICAL SECURITY WARNING: ALLOWED_ORIGINS is not defined in production.');
  }

  app.enableCors({
    origin: (requestOrigin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, etc.)
      if (!requestOrigin) {
        callback(null, true);
        return;
      }

      if (!isProduction) {
        // In development, allow any origin dynamically to support credentials
        callback(null, true);
        return;
      }

      // In production, check if the origin is explicitly allowed
      const isAllowed = allowedOrigins.includes(requestOrigin) || allowedOrigins.includes('*');
      if (isAllowed) {
        callback(null, true);
      } else {
        logger.warn(`CORS blocked request from origin: ${requestOrigin}`);
        callback(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

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
