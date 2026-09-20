import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('System')
@Controller()
export class AppController {
  @Get('test-health')
  @ApiOperation({ summary: 'Check API health' })
  @ApiResponse({ status: 200, description: 'API is healthy' })
  testHealth() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
