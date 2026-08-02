import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters';
import { DecimalSerialiserInterceptor, LoggingInterceptor } from './common/interceptors';
import { JwtAuthGuard, RolesGuard } from './common/guards';
import { validateProductionConfig, type AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(ConfigService);
  const appConfig: AppConfig = {
    nodeEnv: config.get('nodeEnv')!,
    port: config.get('port')!,
    corsOrigins: config.get('corsOrigins')!,
    databaseUrl: config.get('databaseUrl')!,
    redisUrl: config.get('redisUrl')!,
    jwt: config.get('jwt')!,
    cookie: config.get('cookie')!,
    google: config.get('google')!,
    mail: config.get('mail')!,
    marketData: config.get('marketData')!,
    news: config.get('news')!,
    ai: config.get('ai')!,
    notifications: config.get('notifications')!,
    autoscan: config.get('autoscan')!,
    rateLimit: config.get('rateLimit')!,
  };

  // Refuses to boot in production with dev secrets. See configuration.ts.
  validateProductionConfig(appConfig);

  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready'] });

  app.use(cookieParser());
  app.use(
    helmet({
      // The API serves JSON only; CSP here would only affect Swagger UI.
      contentSecurityPolicy: appConfig.nodeEnv === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    origin: appConfig.corsOrigins,
    // Required — the refresh token lives in an httpOnly cookie.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown properties outright rather than stripping them —
      // silently ignoring a misspelled field is how bugs hide.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const reflector = app.get(Reflector);
  app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new DecimalSerialiserInterceptor());

  if (appConfig.nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('AI Trading Intelligence API')
      .setDescription(
        'Indian equities (NSE/BSE), forex, crypto and investment products. ' +
          'Market data, AI analysis, signals, risk management and portfolio tools.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log(`API docs at http://localhost:${appConfig.port}/api/docs`);
  }

  app.enableShutdownHooks();

  await app.listen(appConfig.port, '0.0.0.0');

  logger.log(`API listening on http://localhost:${appConfig.port}/api/v1`);
  logger.log(`Market data providers: ${appConfig.marketData.providers.join(' → ')}`);
  logger.log(`AI service: ${appConfig.ai.url}`);
  logger.log(`Google OAuth: ${appConfig.google.enabled ? 'enabled' : 'disabled (no credentials)'}`);
  logger.log(`Email: ${appConfig.mail.enabled ? 'SMTP' : 'console transport'}`);
}

void bootstrap();
