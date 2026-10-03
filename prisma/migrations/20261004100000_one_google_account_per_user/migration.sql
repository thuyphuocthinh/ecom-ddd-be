-- A user can have only one Google credential. The unique index on (provider, identifier) only stops
-- the same Google account being linked twice; this one also stops two different Google accounts
-- being linked to one user when two requests arrive at the same moment.
CREATE UNIQUE INDEX "UserCredential_userId_google_key" ON "UserCredential"("userId") WHERE "provider" = 'GOOGLE';
