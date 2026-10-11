import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CommandsService, createCommandSchema } from './commands.service.js';

@Controller('devices/:deviceId/commands')
class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Body(new ZodPipe(createCommandSchema))
    body: z.infer<typeof createCommandSchema>,
  ) {
    return this.commands.create(user, deviceId, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string) {
    return this.commands.list(user, deviceId);
  }
}

@Module({
  controllers: [CommandsController],
  providers: [CommandsService],
  exports: [CommandsService],
})
export class CommandsModule {}
