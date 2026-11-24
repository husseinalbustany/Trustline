import { requireEnv } from '../env.js';
import { createDatabase } from '../database/client.js';
import { eq } from 'drizzle-orm';
import { platformAdmins, platformSessions } from '../database/schema.js';
import { hashPassword } from '../security/passwords.js';

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Creates a platform admin, or resets the password of an existing one. Runs
 * as the owner role: the running API cannot create admins.
 */
export async function createPlatformAdmin(input: {
  email: string;
  name: string;
  password: string;
}) {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  const { pool, db } = createDatabase(requireEnv('DATABASE_URL'));
  try {
    const passwordHash = await hashPassword(input.password);
    const email = input.email.trim().toLowerCase();
    const [admin] = await db
      .insert(platformAdmins)
      .values({ email, name: input.name, passwordHash })
      .onConflictDoUpdate({
        target: platformAdmins.email,
        set: {
          name: input.name,
          passwordHash,
          failedAttempts: 0,
          lockedUntil: null,
        },
      })
      .returning({ id: platformAdmins.id });
    // A password reset ends every session that used the old one.
    await db
      .delete(platformSessions)
      .where(eq(platformSessions.adminId, admin.id));
    return email;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const email = await createPlatformAdmin({
    email: requireEnv('PLATFORM_ADMIN_EMAIL'),
    name: requireEnv('PLATFORM_ADMIN_NAME'),
    password: requireEnv('PLATFORM_ADMIN_PASSWORD'),
  });
  console.log(`Platform admin ready: ${email}`);
}
