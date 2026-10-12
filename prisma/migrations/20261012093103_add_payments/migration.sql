-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED');

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(100) NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "providerRef" VARCHAR(100),
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAmount" DECIMAL(12,2),
    "payUrl" VARCHAR(2000),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxMessage" (
    "source" VARCHAR(100) NOT NULL,
    "messageId" VARCHAR(200) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("source","messageId")
);

-- CreateIndex
CREATE INDEX "Payment_orderId_createdAt_idx" ON "Payment"("orderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_orderId_idempotencyKey_key" ON "Payment"("orderId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerRef_key" ON "Payment"("provider", "providerRef");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (Prisma's schema language cannot express this): an order has at most ONE payment
-- waiting for the gateway at any time. Two requests that try to start a payment for the same order
-- together cannot both succeed: the database refuses the second one.
CREATE UNIQUE INDEX "Payment_orderId_initiated_key" ON "Payment"("orderId") WHERE "status" = 'INITIATED';

-- Hand-written: the database itself refuses a payment of no money, a collected amount of no money,
-- and a payment that starts at a version below 1.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paidAmount_positive" CHECK ("paidAmount" IS NULL OR "paidAmount" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_version_positive" CHECK ("version" >= 1);
