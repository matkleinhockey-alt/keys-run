/**
 * Where the capture scripts find the game.
 *
 * Every one of these scripts used to hardcode its own dev-server port — 68 of them across about
 * twenty different ports, each one whatever happened to be free the day it was written. The
 * effect is that none of them run: you start a server, and the script you want goes looking on
 * some other port and times out. Verifying anything meant editing the script first.
 *
 * One address, overridable, defaulting to Vite's usual second port:
 *
 *   node test/capture-rigs.mjs                        # localhost:5174
 *   CLIENT_PORT=5291 node test/capture-rigs.mjs       # somewhere else
 *   CLIENT_URL=http://host:1234 node test/...         # or a whole URL
 *
 * The API server is a separate thing and keeps its own API_URL (see capture-leaderboard-writes).
 */
export const CLIENT_URL = process.env.CLIENT_URL
  ?? (process.env.CLIENT_PORT ? `http://localhost:${process.env.CLIENT_PORT}` : 'http://localhost:5174');
