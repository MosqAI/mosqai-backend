-- AlterTable
ALTER TABLE "devices" ADD COLUMN "cameraId" TEXT;

-- AlterTable
ALTER TABLE "images" ADD COLUMN "aiLogId" BIGINT;

-- AlterTable
ALTER TABLE "ai_results" ADD COLUMN "mosquitoCount" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "devices_cameraId_key" ON "devices"("cameraId");

-- CreateIndex
CREATE UNIQUE INDEX "images_aiLogId_key" ON "images"("aiLogId");

-- AlterTable
ALTER TABLE "capture_days" ADD COLUMN "unidentified" INTEGER NOT NULL DEFAULT 0;
