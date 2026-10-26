/**
 * Builds the URL for the public demo room.
 *
 * Joining after a sign-out starts a clean route: no old room, invite or
 * signed-out marker. A deployment's `?ws=` override is the one thing worth
 * carrying over, because it points at the gateway rather than the room.
 */
export function demoRoomUrl(href: string, displayName?: string): string {
  const url = new URL(href);
  url.hash = '';
  const ws = url.searchParams.get('ws');
  url.search = '';
  if (ws) url.searchParams.set('ws', ws);
  url.searchParams.set('room', 'demo');
  const name = displayName?.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (name) url.searchParams.set('name', name);
  return url.toString();
}
