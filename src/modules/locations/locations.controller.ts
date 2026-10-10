import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LocationsService } from './locations.service.js';
import { ProvinceDto, WardDto } from './dto/location-response.dto.js';

// The data hardly ever changes, so browsers and CDNs may keep an answer for a day
const CACHE_ONE_DAY = 'public, max-age=86400';

@ApiTags('Locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get('provinces')
  @ApiOperation({ summary: 'All provinces and cities (34), by name' })
  @ApiResponse({ status: 200, type: [ProvinceDto] })
  async listProvinces(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProvinceDto[]> {
    const provinces = await this.locations.listProvinces();
    // Set after the lookup, so an error answer is never cached
    res.setHeader('Cache-Control', CACHE_ONE_DAY);
    return provinces;
  }

  @Get('provinces/:code/wards')
  @ApiOperation({
    summary: 'The wards, communes and special zones of a province',
  })
  @ApiParam({ name: 'code', description: 'Province code', example: '01' })
  @ApiResponse({ status: 200, type: [WardDto] })
  @ApiResponse({ status: 404, description: 'No such province (LOC-001)' })
  async listWards(
    @Param('code') code: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WardDto[]> {
    const wards = await this.locations.listWards(code);
    res.setHeader('Cache-Control', CACHE_ONE_DAY);
    return wards;
  }
}
