import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

/**
 * Single error surface for the whole API.
 *
 * Two jobs: give the client a consistent envelope, and make sure internal
 * details never leak. A raw Prisma error contains table and column names — a
 * free schema dump for anyone probing the API.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Something went wrong';
    let error: string | undefined;
    let details: Record<string, string[]> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>;
        message = (record.message as string | string[]) ?? exception.message;
        error = record.error as string | undefined;
        // class-validator produces an array of strings; group them by field so
        // the client can render errors inline.
        if (Array.isArray(record.message)) {
          details = groupValidationErrors(record.message as string[]);
        }
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      ({ status, message } = mapPrismaError(exception));
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Invalid request data';
    } else if (exception instanceof Error) {
      // Log the real thing, return something generic.
      this.logger.error(`${request.method} ${request.url} — ${exception.message}`, exception.stack);
    }

    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url} → ${status}`, exception);
    } else if (status !== 401) {
      // 401s are routine (expired access tokens) and would drown the log.
      this.logger.warn(`${request.method} ${request.url} → ${status}: ${JSON.stringify(message)}`);
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(error ? { error } : {}),
      ...(details ? { details } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

function mapPrismaError(exception: Prisma.PrismaClientKnownRequestError): {
  status: number;
  message: string;
} {
  const target = (exception.meta?.target as string[] | undefined)?.join(', ');

  switch (exception.code) {
    case 'P2002':
      return {
        status: HttpStatus.CONFLICT,
        message: target ? `A record with this ${target} already exists` : 'Record already exists',
      };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, message: 'Record not found' };
    case 'P2003':
      return { status: HttpStatus.BAD_REQUEST, message: 'Related record does not exist' };
    case 'P2014':
      return { status: HttpStatus.BAD_REQUEST, message: 'This change would break a required relation' };
    default:
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Database error' };
  }
}

/** "email must be an email" → { email: ["email must be an email"] } */
function groupValidationErrors(messages: string[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const message of messages) {
    const field = message.split(' ')[0] ?? '_';
    (grouped[field] ??= []).push(message);
  }
  return grouped;
}
