import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrdersService } from './orders.service';

@Injectable()
export class ExpirationScheduler {
  constructor(private ordersService: OrdersService) {}

  @Cron('*/2 * * * * *')
  async handleExpirations() {
    await this.ordersService.processExpiredReservations();
  }
}
