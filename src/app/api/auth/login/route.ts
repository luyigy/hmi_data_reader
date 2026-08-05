import { NextResponse } from 'next/server';
import { authenticateUser, createSessionForUser, AUTH_COOKIE } from '@/lib/auth-users';

export async function POST(request: Request) {
  try {
    const { username, password } = await request.json() as { username?: string; password?: string };
    if (!username || !password) {
      return NextResponse.json({ error: '用户名和密码不能为空' }, { status: 400 });
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    const token = createSessionForUser(user);
    const response = NextResponse.json({
      user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName },
    });

    response.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 86400,
    });

    return response;
  } catch (error) {
    console.error('[Auth] Login error:', error);
    return NextResponse.json({ error: '登录失败' }, { status: 500 });
  }
}
