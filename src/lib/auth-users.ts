import { prisma } from '@/lib/prisma';
import crypto from 'crypto';
import {
  loadAuthConfig,
  verifyAdminCredentials,
  createUserSession,
  verifyOperatorSession,
  AUTH_COOKIE,
  type AuthConfig,
} from '@/lib/auth';

export { AUTH_COOKIE };

function hashWithSalt(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function createPasswordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${hashWithSalt(password, salt)}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const actual = Buffer.from(hashWithSalt(password, salt));
  const expected = Buffer.from(hash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  displayName: string | null;
}

/** Try admin env-var credentials first, then database users */
export async function authenticateUser(username: string, password: string): Promise<AuthUser | null> {
  // 1. Try env-var admin credentials
  try {
    const config = loadAuthConfig();
    if (verifyAdminCredentials(username, password, config)) {
      return { id: 'admin', username: config.adminUsername, role: 'admin', displayName: 'Admin' };
    }
  } catch {
    // auth config not available — fall through to DB users
  }

  // 2. Try database users
  const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return { id: user.id, username: user.username, role: user.role as 'admin' | 'user', displayName: user.displayName };
}

/** Create a session token for the given user */
export function createSessionForUser(user: AuthUser): string {
  const config = loadAuthConfig();
  return createUserSession(user, config);
}

/** Verify a session token cookie value */
export async function verifySessionToken(token: string, config: AuthConfig = loadAuthConfig()): Promise<AuthUser | null> {
  try {
    const ctx = verifyOperatorSession(token, config);
    if (ctx && ctx.tier === 'operator' && !('userId' in ctx)) {
      return { id: 'admin', username: config.adminUsername, role: 'admin', displayName: 'Admin' };
    }
    if (ctx && ctx.tier === 'operator' && 'userId' in ctx) {
      if (ctx.userId === 'admin') {
        return ctx.role === 'admin'
          ? { id: 'admin', username: config.adminUsername, role: 'admin', displayName: 'Admin' }
          : null;
      }
      const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
      if (!user) return null;
      return {
        id: user.id,
        username: user.username,
        role: user.role as 'admin' | 'user',
        displayName: user.displayName,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

export class AuthenticationError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(status === 401 ? 'Authentication required' : 'Administrator access required');
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const cookieToken = (request: Request) => request.headers.get('cookie')
  ?.split(';')
  .map((part) => part.trim().split('='))
  .find(([name]) => name === AUTH_COOKIE)?.slice(1).join('=');

export async function requireCurrentUser(request: Request): Promise<AuthUser> {
  const encodedToken = cookieToken(request);
  let token: string | undefined;
  try {
    token = encodedToken ? decodeURIComponent(encodedToken) : undefined;
  } catch {
    throw new AuthenticationError(401);
  }
  const user = token ? await verifySessionToken(token) : null;
  if (!user) throw new AuthenticationError(401);
  return user;
}

export async function requireAdmin(request: Request): Promise<AuthUser> {
  const user = await requireCurrentUser(request);
  if (user.role !== 'admin') throw new AuthenticationError(403);
  return user;
}

/** Register a new database user (requires env-var admin credentials check by caller) */
export async function registerDbUser(
  username: string,
  password: string,
  role: 'admin' | 'user' = 'user',
  displayName?: string
): Promise<AuthUser> {
  const existing = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
  if (existing) throw new Error('用户名已存在');
  const passwordHash = createPasswordHash(password);
  const user = await prisma.user.create({
    data: { username: username.toLowerCase(), passwordHash, role, displayName: displayName || username },
  });
  return { id: user.id, username: user.username, role: user.role as 'admin' | 'user', displayName: user.displayName };
}

/** List all database users */
export async function listUsers(): Promise<AuthUser[]> {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  return users.map(u => ({
    id: u.id,
    username: u.username,
    role: u.role as 'admin' | 'user',
    displayName: u.displayName,
  }));
}

/** Delete a database user */
export async function deleteUser(userId: string): Promise<void> {
  await prisma.user.delete({ where: { id: userId } });
}
