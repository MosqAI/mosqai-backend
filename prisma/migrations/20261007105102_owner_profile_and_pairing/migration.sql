-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "pairingCodeHash" TEXT,
ADD COLUMN     "placement" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "phone" TEXT;

