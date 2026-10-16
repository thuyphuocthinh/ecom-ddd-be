import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserRole, UserStatus, CredentialProvider } from '@prisma/client';
import * as argon2 from 'argon2';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://root:rootpassword@localhost:5432/ecom_db?schema=public';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@ecom.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin#Secure2026!';
const ADMIN_NAME = 'Quản trị viên Hệ thống';

async function hashPassword(plainText) {
  return argon2.hash(plainText, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

async function main() {
  console.log(`Connecting to database: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}...`);
  await prisma.$connect();
  console.log('Connected to Postgres successfully.');

  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  // Check if credential already exists
  const existingCred = await prisma.userCredential.findUnique({
    where: {
      provider_identifier: {
        provider: CredentialProvider.EMAIL,
        identifier: ADMIN_EMAIL,
      },
    },
    include: {
      user: true,
    },
  });

  if (existingCred) {
    console.log(`User credential for ${ADMIN_EMAIL} already exists (User ID: ${existingCred.userId}).`);
    
    // Update existing user to ADMIN role and ACTIVE status, and reset password
    await prisma.$transaction([
      prisma.user.update({
        where: { id: existingCred.userId },
        data: {
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
          displayName: ADMIN_NAME,
        },
      }),
      prisma.userCredential.update({
        where: { id: existingCred.id },
        data: {
          secret: passwordHash,
        },
      }),
    ]);

    console.log(`Updated user ${ADMIN_EMAIL} to ADMIN role with the new password.`);
  } else {
    const userId = crypto.randomUUID();
    const credId = crypto.randomUUID();

    await prisma.$transaction([
      prisma.user.create({
        data: {
          id: userId,
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
          displayName: ADMIN_NAME,
        },
      }),
      prisma.userCredential.create({
        data: {
          id: credId,
          userId: userId,
          provider: CredentialProvider.EMAIL,
          identifier: ADMIN_EMAIL,
          secret: passwordHash,
        },
      }),
    ]);

    console.log(`Successfully created new ADMIN user: ${ADMIN_EMAIL} (User ID: ${userId}).`);
  }

  console.log('\n=============================================');
  console.log('  ADMIN ACCOUNT CREDENTIALS');
  console.log('=============================================');
  console.log(`  Email:    ${ADMIN_EMAIL}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);
  console.log(`  Role:     ADMIN`);
  console.log(`  Name:     ${ADMIN_NAME}`);
  console.log('=============================================\n');
}

main()
  .catch((err) => {
    console.error('Failed to seed admin account:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
