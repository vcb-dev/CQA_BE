import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const secret = process.env.JWT_SECRET || 'default-secret';
  const refreshSecret = process.env.JWT_REFRESH_SECRET || 'default-refresh-secret';

  if (isProduction) {
    const weakSecrets = [
      'default-secret',
      'your-super-secret-jwt-key-change-in-production',
      'your-super-secret-refresh-key-change-in-production',
      'default-refresh-secret',
    ];
    if (weakSecrets.includes(secret)) {
      throw new Error('❌ CRITICAL SECURITY ERROR: Weak JWT_SECRET config in production environment!');
    }
    if (weakSecrets.includes(refreshSecret)) {
      throw new Error('❌ CRITICAL SECURITY ERROR: Weak JWT_REFRESH_SECRET config in production environment!');
    }
  }

  return {
    secret,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshSecret,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  };
});
