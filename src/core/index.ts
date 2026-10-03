// Domain — pure business primitives, no framework dependencies
export * from './domain/base/entity.base.js';
export * from './domain/base/aggregate-root.base.js';
export * from './domain/base/domain-event.base.js';
export * from './domain/base/value-object.base.js';
export * from './domain/exceptions/domain.exception.js';
export * from './domain/exceptions/error-codes.js';
export * from './domain/types/pagination.js';

// HTTP — web-layer framework glue (filters, interceptors, shared DTOs, logging)
export * from './http/filters/all-exceptions.filter.js';
export * from './http/interceptors/logging.interceptor.js';
export * from './http/interceptors/response.interceptor.js';
export * from './http/interceptors/rate-limit.interceptor.js';
export * from './http/dtos/paginated-response.dto.js';
export * from './http/dtos/pagination-query.dto.js';
export * from './http/logging/app.logger.js';
export * from './http/guards/jwt-auth.guard.js';
export * from './http/guards/roles.guard.js';
export * from './http/decorators/rate-limit.decorator.js';
export * from './http/decorators/current-user.decorator.js';
export * from './http/decorators/client-info.decorator.js';
export * from './http/decorators/roles.decorator.js';
export * from './http/interfaces/authenticated-request.interface.js';

// Infrastructure — external systems (DB, cache, message broker, idempotency)
export * from './infrastructure/cache/cache.constants.js';
export * from './infrastructure/database/prisma.service.js';
export * from './infrastructure/database/database.module.js';
export * from './infrastructure/redis/redis.service.js';
export * from './infrastructure/redis/redis.module.js';
export * from './infrastructure/rabbitmq/rabbitmq.service.js';
export * from './infrastructure/rabbitmq/rabbitmq.module.js';
export * from './infrastructure/idempotency/idempotency.service.js';
export * from './infrastructure/idempotency/idempotency.module.js';
export * from './infrastructure/rate-limit/rate-limit.service.js';
export * from './infrastructure/rate-limit/rate-limit.module.js';
export * from './infrastructure/token/token.store.js';
export * from './infrastructure/token/token.module.js';
export * from './infrastructure/jobs/job-queue.port.js';
export * from './infrastructure/jobs/job-queue.module.js';
export * from './infrastructure/email/email-sender.port.js';
export * from './infrastructure/email/email-dispatcher.port.js';
export * from './infrastructure/email/email-layout.js';
export * from './infrastructure/email/email-sender.factory.js';
export * from './infrastructure/email/log-email-sender.js';
export * from './infrastructure/email/smtp-email-sender.js';
export * from './infrastructure/email/email.module.js';

// Config — settings read from the environment
export * from './config/app.config.js';

// Utils — stateless pure functions
export * from './utils/snowflake.util.js';
export * from './utils/hash.util.js';
export * from './utils/time.util.js';
export * from './utils/string.util.js';
export * from './utils/correlation-id.util.js';
export * from './utils/ttl.util.js';
