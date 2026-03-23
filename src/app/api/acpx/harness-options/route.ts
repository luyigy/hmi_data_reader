import { NextResponse } from 'next/server';
import { deriveGatewayHarnessOptions } from '@/lib/acpx/catalog';

export async function GET() {
  try {
    const options = await deriveGatewayHarnessOptions();
    return NextResponse.json(options);
  } catch (error) {
    console.error('Failed to fetch ACPX harness options:', error);
    return NextResponse.json(
      { error: 'Failed to fetch ACPX harness options' },
      { status: 500 }
    );
  }
}
