import { NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser, AuthenticationError } from '@/lib/auth-users';

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json({ user: await requireCurrentUser(request) });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ user: null }, { status: error.status });
    }
    throw error;
  }
}
