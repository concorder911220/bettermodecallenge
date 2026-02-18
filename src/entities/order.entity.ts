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
import { Reservation } from './reservation.entity';

export enum OrderStatus {
  PENDING = 'PENDING',
  RESERVED = 'RESERVED',
  COMPLETED = 'COMPLETED',
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
}

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  customerId: string;

  @Column({ type: 'uuid' })
  itemId: string;

  @Column({ type: 'int', default: 1 })
  amount: number;

  @ManyToOne(() => Item, (item) => item.orders, { onDelete: 'CASCADE' })
  item: Item;

  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING,
  })
  status: OrderStatus;

  @CreateDateColumn()
  createdAt: Date;

  @OneToOne(() => Reservation, (reservation) => reservation.order, {
    nullable: true,
  })
  @JoinColumn()
  reservation: Reservation | null;
}
