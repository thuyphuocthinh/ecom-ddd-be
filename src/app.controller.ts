import { Controller, Get, Post, Body } from '@nestjs/common';
import { AppService } from './app.service.js';
import { DomainException } from './core/exceptions/domain.exception.js';
import { OrderErrorCodes } from './core/exceptions/error-codes.js';
import { createPaginatedResponse } from './core/utils/pagination.response.js';
import { IsString, IsEmail } from 'class-validator';

class TestDto {
  @IsString()
  name!: string;

  @IsEmail()
  email!: string;
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('test-domain-error')
  testDomainError() {
    throw new DomainException(OrderErrorCodes.OUT_OF_STOCK, {
      requested: 10,
      available: 2,
    });
  }

  @Post('test-validation')
  testValidation(@Body() body: TestDto) {
    return { received: body };
  }

  @Get('test-pagination')
  testPagination() {
    return createPaginatedResponse(
      [
        { id: 1, name: 'Product A' },
        { id: 2, name: 'Product B' },
      ],
      { hasNextPage: true, hasPreviousPage: false, nextCursor: 'XYZ' },
    );
  }
}
