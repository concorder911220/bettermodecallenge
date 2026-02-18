import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../entities/order.entity';
import { Reservation } from '../entities/reservation.entity';
import { Item } from '../entities/item.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ExpirationScheduler } from './expiration.scheduler';

@Module({
  imports: [TypeOrmModule.forFeature([Order, Reservation, Item])],
  controllers: [OrdersController],
  providers: [OrdersService, ExpirationScheduler],
})
export class OrdersModule {}
