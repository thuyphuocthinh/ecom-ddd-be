/**
 * What a one-time code is for. Part of the code's key and of what is hashed, so a
 * code issued for one purpose can never be redeemed for another.
 */
export type OtpPurpose = 'REGISTER_EMAIL' | 'RESET_PASSWORD';
