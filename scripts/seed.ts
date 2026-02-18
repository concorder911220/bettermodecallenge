import { DataSource } from 'typeorm';
import { Item } from '../src/entities/item.entity';
import { Order } from '../src/entities/order.entity';
import { Reservation } from '../src/entities/reservation.entity';

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'inventory',
  entities: [Item, Order, Reservation],
  synchronize: false,
});

async function seed() {
  await dataSource.initialize();
  try {
    await dataSource.query('TRUNCATE reservations, orders, items CASCADE');
    const repo = dataSource.getRepository(Item);
    const items = await repo.save([
      { totalStock: 10 },
      { totalStock: 5 },
      { totalStock: 100 },
      { totalStock: 1 },
      { totalStock: 0 },
    ]);
    console.log('Seeded', items.length, 'items:', items.map((i) => ({ id: i.id, totalStock: i.totalStock })));
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
