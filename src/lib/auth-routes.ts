type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type RouteSurface = 'page' | 'api' | 'socket';
export type RouteAuthRequirement =
  | { access: 'public' | 'authenticated' | 'admin' }
  | { access: 'machine'; subject: 'gateway' | 'feishu'; verification: 'route' }
  | { access: 'self_verified'; verification: 'signed-action' }
  | { access: 'deny' };

type RouteRule = {
  surface: RouteSurface;
  pattern: string;
  methods?: readonly HttpMethod[];
  requirement: RouteAuthRequirement;
};

const authenticated = { access: 'authenticated' } as const;
const admin = { access: 'admin' } as const;
const apiRules = (requirement: RouteAuthRequirement, entries: Array<[string, HttpMethod[]]>) =>
  entries.map(([pattern, methods]): RouteRule => ({ surface: 'api', pattern, methods, requirement }));

const ROUTE_RULES: readonly RouteRule[] = [
  { surface: 'page', pattern: '/login', methods: ['GET'], requirement: { access: 'public' } },
  { surface: 'page', pattern: '/runner.js', methods: ['GET'], requirement: { access: 'public' } },
  ...['/', '/rooms', '/rooms/:id', '/tasks', '/tasks/:id', '/tasks/:id/chat']
    .map((pattern): RouteRule => ({ surface: 'page', pattern, methods: ['GET'], requirement: authenticated })),
  ...['/admin/users', '/agents', '/chat', '/gateway-tools', '/gateways/register', '/remote-ssh-tools', '/workflow', '/workspaces', '/workspaces/:id']
    .map((pattern): RouteRule => ({ surface: 'page', pattern, methods: ['GET'], requirement: admin })),
  { surface: 'api', pattern: '/api/health', methods: ['GET'], requirement: { access: 'public' } },
  ...apiRules({ access: 'public' }, [
    ['/api/auth/login', ['POST']], ['/api/auth/logout', ['POST']], ['/api/auth/me', ['GET']],
    ['/api/runner/claim', ['POST']],
  ]),
  { surface: 'api', pattern: '/api/feishu/grant', methods: ['GET'], requirement: { access: 'self_verified', verification: 'signed-action' } },
  { surface: 'api', pattern: '/api/feishu/webhook', methods: ['POST'], requirement: { access: 'machine', subject: 'feishu', verification: 'route' } },
  ...apiRules({ access: 'machine', subject: 'gateway', verification: 'route' }, [
    ['/api/gateways/register', ['POST']],
    ['/api/gateways/:id/test', ['POST']],
    ['/api/gateways/messages/incoming', ['GET', 'POST']],
    ['/api/gateways/messages/send', ['GET', 'POST']],
  ]),
  ...apiRules(authenticated, [
    ['/api/live-rooms', ['GET', 'POST']],
    ['/api/live-rooms/:id', ['GET', 'PATCH', 'DELETE']],
    ['/api/live-rooms/:id/clear-task-room', ['POST']],
    ['/api/live-rooms/:id/interrupt', ['POST']],
    ['/api/live-rooms/:id/members', ['POST']],
    ['/api/live-rooms/:id/members/:memberId', ['PATCH', 'DELETE']],
    ['/api/live-rooms/:id/messages', ['GET', 'POST']],
    ['/api/live-rooms/:id/speaker', ['POST']],
    ['/api/live-rooms/:id/topic', ['POST']],
    ['/api/remote-nodes', ['GET', 'POST']],
    ['/api/pairing-tickets', ['POST']],
    ['/api/tasks', ['GET', 'POST']],
    ['/api/tasks/:id', ['GET', 'PUT', 'DELETE']],
    ['/api/tasks/:id/control', ['POST']],
    ['/api/tasks/:id/execute', ['POST']],
    ['/api/tasks/:id/logs', ['GET']],
    ['/api/tasks/:id/room', ['GET', 'DELETE']],
    ['/api/tasks/:id/runs', ['GET']],
    ['/api/tasks/:id/runs/latest', ['GET']],
  ]),
  ...apiRules(admin, [
    ['/api/admin/users', ['GET', 'POST']],
    ['/api/admin/users/:id', ['DELETE']],
    ['/api/admin/users/:id/reset-password', ['POST']],
    ['/api/acpx/harness-options', ['GET']],
    ['/api/agents', ['GET']],
    ['/api/agents/:id', ['PATCH']],
    ['/api/agents/register-real', ['GET', 'POST']],
    ['/api/chat/agent-response', ['POST']],
    ['/api/chat/messages', ['GET', 'POST']],
    ['/api/chat/rooms', ['GET']],
    ['/api/control-plane/execute', ['GET', 'POST']],
    ['/api/feishu/connection', ['GET']],
    ['/api/gateways', ['GET', 'POST']],
    ['/api/gateways/:id/agents/refresh', ['POST']],
    ['/api/gateways/:id/health', ['GET']],
    ['/api/gateways/:id/openclaw/config', ['GET', 'POST', 'DELETE']],
    ['/api/gateways/:id/openclaw/respond', ['POST']],
    ['/api/gateways/:id/test', ['GET']],
    ['/api/gateways/chat', ['GET', 'POST']],
    ['/api/gateways/register', ['GET']],
    ['/api/gateways/token', ['GET', 'POST', 'DELETE']],
    ['/api/remote-harness-hosts', ['GET', 'POST']],
    ['/api/remote-harness-hosts/:id', ['PATCH', 'DELETE']],
    ['/api/remote-harness-hosts/:id/test', ['POST']],
    ['/api/socket', ['GET']],
    ['/api/workspaces', ['GET']],
    ['/api/workspaces/:id', ['GET']],
  ]),
  { surface: 'socket', pattern: '/api/socket', requirement: admin },
];

const matchesPattern = (pattern: string, pathname: string) => {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  return expected.length === actual.length
    && expected.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
};

export function resolveRouteAuth(args: {
  surface: RouteSurface;
  pathname: string;
  method?: string;
}): RouteAuthRequirement {
  const pathname = args.pathname.split('?')[0].replace(/\/$/, '') || '/';
  const method = args.method?.toUpperCase();
  const rule = ROUTE_RULES.find((candidate) =>
    candidate.surface === args.surface
    && matchesPattern(candidate.pattern, pathname)
    && (!candidate.methods || (!!method && candidate.methods.includes(method as HttpMethod)))
  );
  return rule?.requirement ?? { access: 'deny' };
}
