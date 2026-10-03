import { Global, Module } from '@nestjs/common';
import { TokenStore } from './token.store.js';

// Global because JwtAuthGuard (core) needs TokenStore in every module that uses it,
// so it must not depend on a feature module (AuthModule) to provide it.
@Global()
@Module({
  providers: [TokenStore],
  exports: [TokenStore],
})
export class TokenModule {}
