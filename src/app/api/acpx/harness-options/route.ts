import { NextResponse } from 'next/server';
import { deriveGatewayHarnessOptions } from '@/lib/acpx/catalog';
import { authenticationErrorResponse, requireCurrentUser } from '@/lib/auth-users';

export async function GET(request: Request) {
  try {
    return NextResponse.json(await deriveGatewayHarnessOptions(await requireCurrentUser(request)));
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    console.error('Failed to fetch ACPX harness options:', error);
    return NextResponse.json(
      { error: 'Failed to fetch ACPX harness options' },
      { status: 500 }
    );
  }
}
