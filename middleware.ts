import { NextRequest, NextResponse } from 'next/server';
import { resolveRouteAuth } from '@/lib/auth-routes';

export async function middleware(request: NextRequest) {
  const surface = request.nextUrl.pathname.startsWith('/api/') ? 'api' : 'page';
  const requirement = resolveRouteAuth({ surface, pathname: request.nextUrl.pathname, method: request.method });

  if (requirement.access === 'public' || requirement.access === 'machine' || requirement.access === 'self_verified') {
    return NextResponse.next();
  }
  if (requirement.access === 'deny') {
    return new NextResponse('Not Found', { status: 404 });
  }

  const authResponse = await fetch(new URL('/api/auth/me', request.url), {
    headers: { cookie: request.headers.get('cookie') || '' },
    cache: 'no-store',
  });
  const user = authResponse.ok
    ? (await authResponse.json() as { user?: { role?: string } }).user
    : null;

  if (!user) {
    if (surface === 'api') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const login = new URL('/login', request.url);
    login.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  if (requirement.access === 'admin' && user.role !== 'admin') {
    return NextResponse.json({ error: 'Administrator access required' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|fonts/).*)'],
};
