import {
  Global,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        max: env.DATABASE_POOL_MAX,
      }),
      // With a single connection (the embedded dev database) transactions queue
      // behind dashboard reads; give them room instead of failing at 2s/5s.
      transactionOptions: { maxWait: 15_000, timeout: 20_000 },
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
