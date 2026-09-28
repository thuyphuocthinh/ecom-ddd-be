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
export * from './http/dtos/paginated-response.dto.js';
export * from './http/dtos/pagination-query.dto.js';
export * from './http/logging/app.logger.js';

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

// Utils — stateless pure functions
export * from './utils/snowflake.util.js';
export * from './utils/hash.util.js';
export * from './utils/time.util.js';
export * from './utils/string.util.js';
export * from './utils/correlation-id.util.js';
