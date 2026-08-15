import { NextResponse } from 'next/server';
import { authenticationErrorResponse, requireAdmin, resetUserPassword } from '@/lib/auth-users';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    await requireAdmin(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) {
      return NextResponse.json({ error: '密码至少 8 位' }, { status: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: params.id }, select: { id: true } });
    if (!user) return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    await resetUserPassword(params.id, password);
    return NextResponse.json({ success: true });
  } catch (error) {
    return authenticationErrorResponse(error)
      ?? NextResponse.json({ error: '重置密码失败' }, { status: 500 });
  }
}
