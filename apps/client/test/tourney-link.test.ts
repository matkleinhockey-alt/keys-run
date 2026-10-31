/**
 * A tournament press must never vanish.
 *
 * Signing in installs the online link (main.ts) the moment the gate closes, whether or not the
 * socket ever connects, and the online `start()` is one fire-and-forget packet that `sendRaw`
 * drops in silence until the connection is welcomed. With the sim server unreachable that made
 * the Tournament button completely dead for signed-in players — no tournament, no toast, no
 * error, press after press, while the very same build worked offline.
 *
 * `ready()` is what lets the caller tell the difference, so it is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { createLocalLink, createNetLink } from '../src/game/tournament/link.js';
import type { NetClient } from '../src/net/client.js';

/** Only the surface the link touches. */
function stubNet(ready: boolean): { net: NetClient; starts: () => number } {
  let starts = 0;
  const net = {
    slotId: 1,
    isReady: () => ready,
    sendTourneyStart: () => { starts++; },
    sendTourneyCatch: () => {},
    sendTourneyDock: () => {},
    nameOf: () => 'Someone',
  } as unknown as NetClient;
  return { net, starts: () => starts };
}

describe('tournament link readiness', () => {
  it('the local link is always ready — it is the floor under an unreachable server', () => {
    expect(createLocalLink().ready()).toBe(true);
  });

  it('the online link is ready only when a packet would actually leave the machine', () => {
    expect(createNetLink(stubNet(true).net, 'Me').ready()).toBe(true);
    expect(createNetLink(stubNet(false).net, 'Me').ready()).toBe(false);
  });

  it('an unready online link still swallows start() — which is why callers must check first', () => {
    const { net, starts } = stubNet(false);
    const link = createNetLink(net, 'Me');
    link.start();
    // The packet is sent; NetClient.sendRaw is what drops it. Nothing here reports that, and
    // nothing here can: the only signal available to the caller ahead of time is ready().
    expect(starts()).toBe(1);
    expect(link.current()).toBeNull();
    expect(link.ready()).toBe(false);
  });

  it('a local tournament actually starts, so falling back to it is worth doing', () => {
    const link = createLocalLink();
    expect(link.current()).toBeNull();
    link.start();
    expect(link.current()).not.toBeNull();
    expect(link.current()!.species).toHaveLength(5);
  });

  it('online has no abort: a shared tournament belongs to everyone and runs out', () => {
    expect(createNetLink(stubNet(true).net, 'Me').abort).toBeUndefined();
    expect(typeof createLocalLink().abort).toBe('function');
  });
});
