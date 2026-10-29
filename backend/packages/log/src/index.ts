import pino from 'pino';
import type { Logger, Bindings } from 'pino';
import { type Writable } from 'node:stream';

export interface LoggerOptions {
  service: string;
  destination?: Writable;
  pretty?: boolean;
}

export interface ChildBindings extends Bindings {
  ownerId?: string;
  agentId?: string;
  conversationId?: string;
  runId?: string;
  step?: string;
  wakeId?: string;
}

const SECRET_FIELD_PATTERN = /^(token|apikey|api_key|authorization|password|secret)$/i;

function isPlainObject(obj: unknown): obj is Record<string, unknown> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    !Array.isArray(obj) &&
    Object.getPrototypeOf(obj) === Object.prototype
  );
}

function redactSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item));
  }

  if (!isPlainObject(obj)) {
    return obj;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redactSecrets(value);
    }
  }
  return redacted;
}

function redactRecord(obj: Record<string, unknown>): Record<string, unknown> {
  const result = redactSecrets(obj);
  return isPlainObject(result) ? result : obj;
}

export function createLogger(options: LoggerOptions): Logger {
  const { service, destination } = options;

  const pinoOptions: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || 'info',
    base: { service },
    serializers: {
      err: pino.stdSerializers.err,
    },
    formatters: {
      log(obj: Record<string, unknown>): Record<string, unknown> {
        return redactRecord(obj);
      },
    },
  };

  // Note: pretty printing with pino-pretty would require installing the package separately
  // For now, we focus on JSON logging which is the default and used by the verify test
  if (destination) {
    return pino(pinoOptions, destination);
  }

  return pino(pinoOptions);
}

export function createLoggerWithChild(options: LoggerOptions) {
  const logger = createLogger(options);
  return {
    logger,
    child: (bindings: ChildBindings) => logger.child(bindings),
  };
}
