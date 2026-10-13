import { DynamicModule, Global, Module } from '@nestjs/common';
import { AiImportModule } from './ai-import/ai-import.service.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { DirectoryModule } from './common/directory.module.js';
import { ENV, type Env } from './config/env.js';
import { DevicesModule } from './devices/devices.module.js';
import { MailModule } from './mail/mail.service.js';
import { MqttModule } from './mqtt/mqtt.service.js';
import { OwnerModule } from './owner/owner.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SchedulesModule } from './schedules/schedules.module.js';
import { TelemetryModule } from './telemetry/telemetry.service.js';
import { UsersModule } from './users/users.module.js';

@Global()
@Module({})
class EnvModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}

@Module({})
export class AppModule {
  /** Env is passed in (not read globally) so tests can run the app against their own config. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        PrismaModule,
        MqttModule,
        MailModule,
        AuthModule,
        UsersModule,
        TelemetryModule,
        CommandsModule,
        DevicesModule,
        AnalyticsModule,
        AlertsModule,
        DirectoryModule,
        OwnerModule,
        SchedulesModule,
        AiImportModule,
      ],
    };
  }
}
