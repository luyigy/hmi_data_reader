import { NextResponse } from 'next/server';
import {
  authenticationErrorResponse,
  listUsers,
  registerDbUser,
  requireAdmin,
} from '@/lib/auth-users';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    return NextResponse.json({ users: await listUsers() });
  } catch (error) {
    return authenticationErrorResponse(error)
      ?? NextResponse.json({ error: '获取用户失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username) || password.length < 8 || displayName.length > 100) {
      return NextResponse.json({ error: '用户名须为 3-64 位字母、数字或 ._-，密码至少 8 位' }, { status: 400 });
    }
    const user = await registerDbUser(username, password, 'user', displayName || username);
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    const authResponse = authenticationErrorResponse(error);
    if (authResponse) return authResponse;
    const message = error instanceof Error && error.message === '用户名已存在' ? error.message : '创建用户失败';
    return NextResponse.json({ error: message }, { status: message === '用户名已存在' ? 409 : 500 });
  }
}
