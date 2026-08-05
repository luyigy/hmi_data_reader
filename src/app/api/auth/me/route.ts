import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, AUTH_COOKIE } from '@/lib/auth-users';

export async function GET(request: NextRequest) {
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (!token) return NextResponse.json({ user: null }, { status: 401 });

  const user = verifySessionToken(token);
  if (!user) return NextResponse.json({ user: null }, { status: 401 });

  return NextResponse.json({ user });
}
