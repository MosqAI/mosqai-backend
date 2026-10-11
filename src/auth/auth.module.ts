import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Patch,
  Post,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CurrentUser, Public, type AuthUser } from './auth.decorators.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });
const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email(),
  phone: z.string().trim().min(6).max(20).optional(),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  language: z.enum(['en', 'rw', 'fr']).optional(),
});
const profileSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().min(6).max(20).nullable().optional(),
  language: z.enum(['en', 'rw', 'fr']).optional(),
});
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'Use at least 10 characters').max(200),
});

@Controller('auth')
class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body.email, body.password);
  }

  @Public()
  @Post('register')
  register(
    @Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>,
  ) {
    return this.auth.register(body);
  }

  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(profileSchema)) body: z.infer<typeof profileSchema>,
  ) {
    return this.auth.updateProfile(user.id, body);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>,
  ) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>,
  ) {
    await this.auth.logout(body.refreshToken);
  }

  /** Returns a fresh token pair: every other session is signed out. */
  @Post('change-password')
  @HttpCode(200)
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>,
  ) {
    return this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ENV],
      useFactory: (env: Env) => ({ secret: env.JWT_ACCESS_SECRET }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
