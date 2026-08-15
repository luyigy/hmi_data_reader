import { NextResponse } from 'next/server';
import { authenticationErrorResponse, requireCurrentUser } from '@/lib/auth-users';
import { createPairingTicket } from '@/lib/pairing-tickets';

export async function POST(request: Request) {
  try {
    return NextResponse.json(await createPairingTicket(await requireCurrentUser(request)), { status: 201 });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    console.error('[PairingTickets] Error:', error);
    return NextResponse.json({ error: 'Failed to create pairing ticket' }, { status: 500 });
  }
}
