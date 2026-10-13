-- CreateEnum
CREATE TYPE "ScheduleAction" AS ENUM ('ON', 'OFF');

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "powerOn" BOOLEAN;

-- CreateTable
CREATE TABLE "device_schedules" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "action" "ScheduleAction" NOT NULL,
    "time" TEXT NOT NULL,
    "days" INTEGER[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_schedules_deviceId_idx" ON "device_schedules"("deviceId");

-- AddForeignKey
ALTER TABLE "device_schedules" ADD CONSTRAINT "device_schedules_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

