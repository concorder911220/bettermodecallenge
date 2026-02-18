import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { OrdersService } from '../src/orders/orders.service';
import { ExpirationScheduler } from '../src/orders/expiration.scheduler';
import { DataSource } from 'typeorm';
import { OrderStatus } from '../src/entities/order.entity';
import { ReservationStatus } from '../src/entities/reservation.entity';

describe('Orders (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let itemId: string;

  beforeAll(async () => {
    process.env.RESERVATION_TTL_SEC = '2';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ExpirationScheduler)
      .useValue({ handleExpirations: async () => {} })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    dataSource = moduleFixture.get(DataSource);
  }, 15000);

  beforeEach(async () => {
    const res = await request(app.getHttpServer())
      .post('/items')
      .send({ totalStock: 10 })
      .expect(201);
    itemId = res.body.id;
  });

  afterEach(async () => {
    if (dataSource?.query) {
      await new Promise((r) => setTimeout(r, 100));
      await dataSource.query(
        'TRUNCATE reservations, orders, items CASCADE',
      );
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('POST /orders reserves when stock available, pending otherwise', async () => {
    const r = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'user-1', itemId })
      .expect(201);
    expect(r.body.status).toBe(OrderStatus.RESERVED);
    expect(r.body.reservation).toBeDefined();
    expect(r.body.reservation.status).toBe(ReservationStatus.ACTIVE);
    expect(r.body.expiresAt).toBeDefined();
  });

  it('concurrency: 100 parallel POST /orders with stock=10 → exactly 10 RESERVED, 90 PENDING', async () => {
    const doRequest = () =>
      request(app.getHttpServer())
        .post('/orders')
        .send({ customerId: `user-${Math.random()}`, itemId });
    const withRetry = async (attempt = 0): Promise<any> => {
      try {
        const res = await doRequest();
        if (res.status === 201) return res;
        if ((res.status === 500 || res.status === 0) && attempt < 8) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          return withRetry(attempt + 1);
        }
        return res;
      } catch (e) {
        if (attempt < 8) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          return withRetry(attempt + 1);
        }
        throw e;
      }
    };
    const promises = Array.from({ length: 100 }, () => withRetry());
    const results = await Promise.all(promises);
    const reserved = results.filter((r) => r.body?.status === OrderStatus.RESERVED);
    const pending = results.filter((r) => r.body?.status === OrderStatus.PENDING);
    const failed = results.filter((r) => r.status !== 201);
    expect(failed.length).toBe(0);
    expect(reserved.length).toBe(10);
    expect(pending.length).toBe(90);
  }, 60000);

  it('GET /orders/:id returns order', async () => {
    const created = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u', itemId })
      .expect(201);
    const got = await request(app.getHttpServer())
      .get(`/orders/${created.body.id}`)
      .expect(200);
    expect(got.body.id).toBe(created.body.id);
    expect(got.body.status).toBe(OrderStatus.RESERVED);
  });

  it('POST /orders/:id/pay completes order and is idempotent', async () => {
    const created = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u', itemId })
      .expect(201);
    const paid = await request(app.getHttpServer())
      .post(`/orders/${created.body.id}/pay`)
      .expect(201);
    expect(paid.body.status).toBe(OrderStatus.COMPLETED);
    expect(paid.body.reservation.status).toBe(ReservationStatus.FINALIZED);
    const paidAgain = await request(app.getHttpServer())
      .post(`/orders/${created.body.id}/pay`)
      .expect(201);
    expect(paidAgain.body.status).toBe(OrderStatus.COMPLETED);
  });

  it('expiry: after TTL order becomes EXPIRED and next PENDING is promoted', async () => {
    const itemRes = await request(app.getHttpServer())
      .post('/items')
      .send({ totalStock: 1 })
      .expect(201);
    const singleItemId = itemRes.body.id;
    const created = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u1', itemId: singleItemId })
      .expect(201);
    expect(created.body.status).toBe(OrderStatus.RESERVED);
    const pending = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u2', itemId: singleItemId })
      .expect(201);
    expect(pending.body.status).toBe(OrderStatus.PENDING);
    await new Promise((r) => setTimeout(r, 3500));
    const ordersService = app.get(OrdersService);
    await ordersService.processExpiredReservations();
    await ordersService.processExpiredReservations();
    const expiredOrder = await request(app.getHttpServer())
      .get(`/orders/${created.body.id}`)
      .expect(200);
    expect(expiredOrder.body.status).toBe(OrderStatus.EXPIRED);
    const promoted = await request(app.getHttpServer())
      .get(`/orders/${pending.body.id}`)
      .expect(200);
    expect(promoted.body.status).toBe(OrderStatus.RESERVED);
  }, 10000);

  it('payment vs expiry: pay after expiry fails', async () => {
    const itemRes = await request(app.getHttpServer())
      .post('/items')
      .send({ totalStock: 1 })
      .expect(201);
    const singleItemId = itemRes.body.id;
    const created = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u', itemId: singleItemId })
      .expect(201);
    expect(created.body.status).toBe(OrderStatus.RESERVED);
    await new Promise((r) => setTimeout(r, 3500));
    const ordersService = app.get(OrdersService);
    await ordersService.processExpiredReservations();
    await ordersService.processExpiredReservations();
    const expiredOrder = await request(app.getHttpServer())
      .get(`/orders/${created.body.id}`)
      .expect(200);
    expect(expiredOrder.body.status).toBe(OrderStatus.EXPIRED);
    await request(app.getHttpServer())
      .post(`/orders/${created.body.id}/pay`)
      .expect(404);
  }, 10000);

  it('order with amount: can reserve multiple units in one order', async () => {
    const itemRes = await request(app.getHttpServer())
      .post('/items')
      .send({ totalStock: 5 })
      .expect(201);
    const id = itemRes.body.id;
    const order1 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'a', itemId: id, amount: 3 })
      .expect(201);
    expect(order1.body.status).toBe(OrderStatus.RESERVED);
    expect(order1.body.amount).toBe(3);
    const order2 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'b', itemId: id, amount: 2 })
      .expect(201);
    expect(order2.body.status).toBe(OrderStatus.RESERVED);
    const order3 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'c', itemId: id, amount: 1 })
      .expect(201);
    expect(order3.body.status).toBe(OrderStatus.PENDING);
  });

  it('item sold out: cannot create order when totalStock fully sold', async () => {
    const itemRes = await request(app.getHttpServer())
      .post('/items')
      .send({ totalStock: 2 })
      .expect(201);
    const id = itemRes.body.id;
    const o1 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u1', itemId: id, amount: 1 })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/${o1.body.id}/pay`)
      .expect(201);
    const o2 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u2', itemId: id, amount: 1 })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/${o2.body.id}/pay`)
      .expect(201);
    await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u3', itemId: id, amount: 1 })
      .expect(400);
  });

  it('when last unit sold, PENDING orders for that item become EXPIRED', async () => {
    const itemRes = await request(app.getHttpServer())
      .post('/items')
      .send({ totalStock: 1 })
      .expect(201);
    const id = itemRes.body.id;
    const o1 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u1', itemId: id, amount: 1 })
      .expect(201);
    expect(o1.body.status).toBe(OrderStatus.RESERVED);
    const o2 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u2', itemId: id, amount: 1 })
      .expect(201);
    expect(o2.body.status).toBe(OrderStatus.PENDING);
    await request(app.getHttpServer())
      .post(`/orders/${o1.body.id}/pay`)
      .expect(201);
    const o2After = await request(app.getHttpServer())
      .get(`/orders/${o2.body.id}`)
      .expect(200);
    expect(o2After.body.status).toBe(OrderStatus.EXPIRED);
  });

  it('POST /orders/:id/cancel cancels PENDING order', async () => {
    const itemRes = await request(app.getHttpServer())
      .post('/items')
      .send({ totalStock: 1 })
      .expect(201);
    const o1 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u1', itemId: itemRes.body.id, amount: 1 })
      .expect(201);
    const o2 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u2', itemId: itemRes.body.id, amount: 1 })
      .expect(201);
    expect(o2.body.status).toBe(OrderStatus.PENDING);
    const canceled = await request(app.getHttpServer())
      .post(`/orders/${o2.body.id}/cancel`)
      .expect(200);
    expect(canceled.body.status).toBe(OrderStatus.CANCELED);
  });

  it('POST /orders/:id/cancel cancels RESERVED order and promotes next PENDING', async () => {
    const itemRes = await request(app.getHttpServer())
      .post('/items')
      .send({ totalStock: 1 })
      .expect(201);
    const id = itemRes.body.id;
    const o1 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u1', itemId: id, amount: 1 })
      .expect(201);
    const o2 = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'u2', itemId: id, amount: 1 })
      .expect(201);
    expect(o1.body.status).toBe(OrderStatus.RESERVED);
    expect(o2.body.status).toBe(OrderStatus.PENDING);
    await request(app.getHttpServer())
      .post(`/orders/${o1.body.id}/cancel`)
      .expect(200);
    const o2After = await request(app.getHttpServer())
      .get(`/orders/${o2.body.id}`)
      .expect(200);
    expect(o2After.body.status).toBe(OrderStatus.RESERVED);
  });
});
