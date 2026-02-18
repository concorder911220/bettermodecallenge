import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Order } from './order.entity';
import { Reservation } from './reservation.entity';

@Entity('items')
export class Item {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int', default: 0 })
  totalStock: number;

  @Column({ type: 'int', default: 0 })
  soldStock: number;

  @OneToMany(() => Order, (order) => order.item)
  orders: Order[];

  @OneToMany(() => Reservation, (reservation) => reservation.item)
  reservations: Reservation[];
}
