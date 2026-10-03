-- Why a session was closed when the password was reset or changed
ALTER TYPE "SessionRevokeReason" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET';
ALTER TYPE "SessionRevokeReason" ADD VALUE IF NOT EXISTS 'PASSWORD_CHANGED';
