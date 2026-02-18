import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Item } from './item.entity';
import { Order } from './order.entity';

export enum ReservationStatus {
  ACTIVE = 'ACTIVE',
  FINALIZED = 'FINALIZED',
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
}

@Entity('reservations')
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  orderId: string;

  @OneToOne(() => Order, (order) => order.reservation, { onDelete: 'CASCADE' })
  @JoinColumn()
  order: Order;

  @Column({ type: 'uuid' })
  itemId: string;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @ManyToOne(() => Item, (item) => item.reservations, { onDelete: 'CASCADE' })
  item: Item;

  @Column({
    type: 'enum',
    enum: ReservationStatus,
    default: ReservationStatus.ACTIVE,
  })
  status: ReservationStatus;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
