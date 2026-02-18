import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { Reservation, ReservationStatus } from '../entities/reservation.entity';
import { Item } from '../entities/item.entity';
import { CreateOrderDto } from './dto/create-order.dto';

function getReservationTtlSec(): number {
  return parseInt(process.env.RESERVATION_TTL_SEC ?? '180', 10) || 20;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private orderRepo: Repository<Order>,
    @InjectRepository(Reservation)
    private reservationRepo: Repository<Reservation>,
    @InjectRepository(Item)
    private itemRepo: Repository<Item>,
    private dataSource: DataSource,
  ) {}

  async create(dto: CreateOrderDto) {
    const amount = dto.amount ?? 1;
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const item = await manager
            .getRepository(Item)
            .createQueryBuilder('item')
            .setLock('pessimistic_write')
            .where('item.id = :id', { id: dto.itemId })
            .getOne();

          if (!item) throw new NotFoundException('Item not found');

          const availableForSale = item.totalStock - (item.soldStock ?? 0);
          if (availableForSale < amount) {
            throw new BadRequestException('Item sold out');
          }

          const activeSum = await manager
            .getRepository(Reservation)
            .createQueryBuilder('r')
            .select('COALESCE(SUM(r.quantity), 0)', 'sum')
            .where('r.itemId = :itemId', { itemId: dto.itemId })
            .andWhere('r.status = :status', { status: ReservationStatus.ACTIVE })
            .getRawOne<{ sum: string }>();
          const activeReservedQuantity = parseInt(activeSum?.sum ?? '0', 10);
          const availableToReserve = availableForSale - activeReservedQuantity;

          if (availableToReserve >= amount) {
            const expiresAt = new Date(Date.now() + getReservationTtlSec() * 1000);
            const order = manager.getRepository(Order).create({
              customerId: dto.customerId,
              itemId: dto.itemId,
              amount,
              status: OrderStatus.RESERVED,
            });
            const savedOrder = await manager.getRepository(Order).save(order);
            const reservation = await manager.getRepository(Reservation).save({
              orderId: savedOrder.id,
              itemId: dto.itemId,
              quantity: amount,
              status: ReservationStatus.ACTIVE,
              expiresAt,
            });
            savedOrder.reservation = reservation;
            await manager.getRepository(Order).save(savedOrder);
            const withReservation = await manager.getRepository(Order).findOne({
              where: { id: savedOrder.id },
              relations: ['reservation'],
            });
            return {
              ...withReservation!,
              expiresAt,
            };
          }

          const order = manager.getRepository(Order).create({
            customerId: dto.customerId,
            itemId: dto.itemId,
            amount,
            status: OrderStatus.PENDING,
          });
          return manager.getRepository(Order).save(order);
        });
      } catch (err: any) {
        if (err?.code === '40P01' && attempt < maxRetries) {
          this.logger.warn(
            `Deadlock on create order, retry ${attempt}/${maxRetries}`,
          );
          continue;
        }
        throw err;
      }
    }
    throw new Error('Create order failed after retries');
  }

  async findOne(id: string) {
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: ['reservation'],
    });
    if (!order) throw new NotFoundException('Order not found');
    if (
      order.status === OrderStatus.RESERVED &&
      order.reservation?.status === ReservationStatus.ACTIVE
    ) {
      return { ...order, expiresAt: order.reservation.expiresAt };
    }
    return order;
  }

  async pay(orderId: string) {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder('order')
        .where('order.id = :orderId', { orderId })
        .setLock('pessimistic_write')
        .getOne();

      if (!order) throw new NotFoundException('Order not found');

      if (order.status === OrderStatus.COMPLETED) {
        return manager.getRepository(Order).findOne({
          where: { id: orderId },
          relations: ['reservation'],
        });
      }

      const reservation = await manager
        .getRepository(Reservation)
        .createQueryBuilder('r')
        .where('r.orderId = :orderId', { orderId })
        .setLock('pessimistic_write')
        .getOne();
      if (
        !reservation ||
        reservation.status !== ReservationStatus.ACTIVE ||
        new Date(reservation.expiresAt) <= new Date()
      ) {
        throw new NotFoundException(
          'Order is not in a payable state (no active reservation or expired)',
        );
      }

      const reservationUpdate = await manager
        .getRepository(Reservation)
        .createQueryBuilder()
        .update(Reservation)
        .set({ status: ReservationStatus.FINALIZED })
        .where('id = :id', { id: reservation.id })
        .andWhere('status = :status', { status: ReservationStatus.ACTIVE })
        .execute();

      if (reservationUpdate.affected === 0) {
        const updatedOrder = await manager.getRepository(Order).findOne({
          where: { id: orderId },
          relations: ['reservation'],
        });
        if (updatedOrder?.status === OrderStatus.COMPLETED) {
          return updatedOrder;
        }
        throw new NotFoundException(
          'Order is not in a payable state (reservation was modified)',
        );
      }

      await manager
        .getRepository(Order)
        .createQueryBuilder()
        .update(Order)
        .set({ status: OrderStatus.COMPLETED })
        .where('id = :id', { id: orderId })
        .andWhere('status != :completed', { completed: OrderStatus.COMPLETED })
        .execute();

      const amount = order.amount ?? 1;
      await manager
        .getRepository(Item)
        .increment({ id: order.itemId }, 'soldStock', amount);

      const item = await manager.getRepository(Item).findOne({
        where: { id: order.itemId },
      });
      if (item && item.soldStock >= item.totalStock) {
        await manager
          .getRepository(Order)
          .createQueryBuilder()
          .update(Order)
          .set({ status: OrderStatus.EXPIRED })
          .where('itemId = :itemId', { itemId: order.itemId })
          .andWhere('status = :status', { status: OrderStatus.PENDING })
          .execute();
      }

      return manager.getRepository(Order).findOne({
        where: { id: orderId },
        relations: ['reservation'],
      });
    });
  }

  async cancel(orderId: string) {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder('order')
        .where('order.id = :orderId', { orderId })
        .setLock('pessimistic_write')
        .getOne();

      if (!order) throw new NotFoundException('Order not found');

      if (
        order.status === OrderStatus.COMPLETED ||
        order.status === OrderStatus.EXPIRED ||
        order.status === OrderStatus.CANCELED
      ) {
        throw new BadRequestException('Order cannot be canceled');
      }

      if (order.status === OrderStatus.PENDING) {
        await manager
          .getRepository(Order)
          .update(orderId, { status: OrderStatus.CANCELED });
        return manager.getRepository(Order).findOne({
          where: { id: orderId },
          relations: ['reservation'],
        });
      }

      const reservation = await manager
        .getRepository(Reservation)
        .createQueryBuilder('r')
        .where('r.orderId = :orderId', { orderId })
        .setLock('pessimistic_write')
        .getOne();

      if (reservation && reservation.status === ReservationStatus.ACTIVE) {
        await manager
          .getRepository(Reservation)
          .update(reservation.id, { status: ReservationStatus.CANCELED });
      }

      await manager
        .getRepository(Order)
        .update(orderId, { status: OrderStatus.CANCELED });

      if (reservation?.status === ReservationStatus.ACTIVE) {
        await this.promoteNextPending(manager, order.itemId);
      }

      return manager.getRepository(Order).findOne({
        where: { id: orderId },
        relations: ['reservation'],
      });
    });
  }

  async processExpiredReservations() {
    const expired = await this.reservationRepo
      .createQueryBuilder('r')
      .where('r.status = :status', { status: ReservationStatus.ACTIVE })
      .andWhere('r.expiresAt <= :now', { now: new Date() })
      .orderBy('r.expiresAt', 'ASC')
      .take(50)
      .getMany();

    for (const res of expired) {
      await this.dataSource
        .transaction(async (manager) => {
          const locked = await manager
            .getRepository(Reservation)
            .createQueryBuilder('r')
            .where('r.id = :id', { id: res.id })
            .andWhere('r.status = :status', {
              status: ReservationStatus.ACTIVE,
            })
            .setLock('pessimistic_write', undefined, ['r'])
            .setOnLocked('skip_locked')
            .getOne();

          if (!locked) {
            return;
          }

          const reservationUpdate = await manager
            .getRepository(Reservation)
            .createQueryBuilder()
            .update(Reservation)
            .set({ status: ReservationStatus.EXPIRED })
            .where('id = :id', { id: res.id })
            .andWhere('status = :status', { status: ReservationStatus.ACTIVE })
            .execute();

          if (reservationUpdate.affected === 0) {
            return;
          }

          await manager
            .getRepository(Order)
            .createQueryBuilder()
            .update(Order)
            .set({ status: OrderStatus.EXPIRED })
            .where('id = :id', { id: res.orderId })
            .andWhere('status = :status', { status: OrderStatus.RESERVED })
            .execute();

          await this.promoteNextPending(manager, res.itemId);
        })
        .catch((error: Error) => {
          this.logger.error(
            `Failed to process expired reservation ${res.id}: ${error.message}`,
          );
        });
    }
  }

  private async promoteNextPending(
    manager: EntityManager,
    itemId: string,
  ): Promise<void> {
    const item = await manager
      .getRepository(Item)
      .createQueryBuilder('item')
      .setLock('pessimistic_write')
      .where('item.id = :id', { id: itemId })
      .getOne();

    if (!item) {
      this.logger.warn(`Item ${itemId} not found during promotion`);
      return;
    }

    const nextOrder = await manager
      .getRepository(Order)
      .createQueryBuilder('o')
      .setLock('pessimistic_write', undefined, ['o'])
      .setOnLocked('skip_locked')
      .where('o.itemId = :itemId', { itemId })
      .andWhere('o.status = :status', { status: OrderStatus.PENDING })
      .orderBy('o.createdAt', 'ASC')
      .take(1)
      .getOne();

    if (!nextOrder) return;

    const availableForSale = item.totalStock - (item.soldStock ?? 0);
    if (availableForSale < (nextOrder.amount ?? 1)) {
      return;
    }

    const activeSum = await manager
      .getRepository(Reservation)
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.quantity), 0)', 'sum')
      .where('r.itemId = :itemId', { itemId })
      .andWhere('r.status = :status', { status: ReservationStatus.ACTIVE })
      .getRawOne<{ sum: string }>();
    const activeReservedQuantity = parseInt(activeSum?.sum ?? '0', 10);
    const availableToReserve = availableForSale - activeReservedQuantity;
    const orderAmount = nextOrder.amount ?? 1;
    if (availableToReserve < orderAmount) {
      return;
    }

    const expiresAt = new Date(Date.now() + getReservationTtlSec() * 1000);

    const existingReservation = await manager
      .getRepository(Reservation)
      .findOne({ where: { orderId: nextOrder.id } });

    if (existingReservation) {
      this.logger.warn(
        `Reservation already exists for order ${nextOrder.id} during promotion`,
      );
      return;
    }

    await manager.getRepository(Reservation).save({
      orderId: nextOrder.id,
      itemId,
      quantity: orderAmount,
      status: ReservationStatus.ACTIVE,
      expiresAt,
    });

    const orderUpdate = await manager
      .getRepository(Order)
      .createQueryBuilder()
      .update(Order)
      .set({ status: OrderStatus.RESERVED })
      .where('id = :id', { id: nextOrder.id })
      .andWhere('status = :status', { status: OrderStatus.PENDING })
      .execute();

    if (orderUpdate.affected === 0) {
      this.logger.warn(
        `Order ${nextOrder.id} status changed during promotion, rolling back reservation`,
      );
      await manager
        .getRepository(Reservation)
        .delete({ orderId: nextOrder.id });
    }
  }
}
