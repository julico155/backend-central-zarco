import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { AppConfig } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<AppConfig, true>);

  // El JWT de staff viaja en el header Authorization, no en cookie: sin
  // credentials no hace falta exponer el origen a nivel de cookies.
  app.enableCors({
    origin: config.get('corsOrigins', { infer: true }),
    credentials: false,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());

  // /docs-json es la fuente de los tipos del front: se genera el cliente con
  // openapi-typescript en vez de mantener las interfaces a mano.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Backend central La Fija')
    .setDescription('Menú, pedidos, pagos y delivery. Contrato del POS en docs/pos-integration.md.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, swaggerConfig), {
    jsonDocumentUrl: 'docs-json',
  });

  await app.listen(config.get('port', { infer: true }));
}

bootstrap();
