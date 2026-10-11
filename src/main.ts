import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { parseEnv } from './config/env.js';

const env = parseEnv(process.env);
const app = configureApp(await NestFactory.create(AppModule.forRoot(env)), env);
await app.listen(env.PORT);
