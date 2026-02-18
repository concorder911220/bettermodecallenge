import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse({ status: 201, description: 'Order created (RESERVED or PENDING)' })
  create(@Body() dto: CreateOrderDto) {
    return this.ordersService.create(dto);
  }

  @Get(':id')
  @ApiResponse({ status: 200, description: 'Order by id' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.findOne(id);
  }

  @Post(':id/pay')
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse({ status: 201, description: 'Payment completed' })
  @ApiResponse({ status: 404, description: 'Not payable (expired or no reservation)' })
  pay(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.pay(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 200, description: 'Order canceled' })
  @ApiResponse({ status: 400, description: 'Order cannot be canceled (completed/expired/canceled)' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.cancel(id);
  }
}
