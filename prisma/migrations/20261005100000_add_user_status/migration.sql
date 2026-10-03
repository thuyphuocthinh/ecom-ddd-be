-- Accounts can be suspended by an administrator. Every existing account stays ACTIVE.
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
