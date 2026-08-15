import { NextResponse } from 'next/server';
import { authenticationErrorResponse, deleteUser, requireAdmin } from '@/lib/auth-users';
import { prisma } from '@/lib/prisma';

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const currentUser = await requireAdmin(request);
    if (currentUser.id === params.id) {
      return NextResponse.json({ error: '不能删除当前登录用户' }, { status: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: params.id }, select: { id: true } });
    if (!user) return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    await deleteUser(params.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return authenticationErrorResponse(error)
      ?? NextResponse.json({ error: '删除用户失败' }, { status: 500 });
  }
}
