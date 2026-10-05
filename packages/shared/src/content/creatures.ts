/**
 * Sea-life visual specs: ambient-life rendering parameters (VIS), the per-zone ambient-life
 * tables (ZONE_LIFE), and lofted-fish-body shape parameters (SHAPE).
 *
 * Ported faithfully from legacy/index.html lines 2154-2213 (VIS, ZONE_LIFE) and 2302-2348
 * (SHAPE). These are plain data describing geometry/color inputs for a three.js builder that
 * stays client-side (buildCreatureGeo / buildFishGeo) — the data itself has no three.js
 * dependency. Every value preserved exactly.
 */

export interface CreatureVis {
  kind: string;
  len: number;
  h?: number;
  w?: number;
  wing?: number;
  back: string;
  belly?: string;
  fin?: string;
  pattern?: string;
  blunt?: boolean;
  sail?: boolean;
  bill?: number;
  wings?: boolean;
  flap?: boolean;
  tuna?: boolean;
  finlet?: string;
  sickle?: number;
  longPec?: boolean;
  level: string;
  speed: number;
  school: [number, number];
  spread: number;
  dMin: number;
  dMax: number;
  act?: string;
}

export const VIS: Record<string, CreatureVis> = {
  bonefish:{kind:'fish',len:.65,h:.15,w:.11,back:'#6f8a82',belly:'#e3ebe8',fin:'#9fb1aa',level:'mid',speed:1.4,school:[3,7],spread:2.4,dMin:.35,dMax:4,act:'tail'},
  permit:{kind:'fish',len:.75,h:.42,w:.1,back:'#5e6f78',belly:'#d9e1e4',fin:'#22282d',level:'mid',speed:1.3,school:[2,4],spread:2.6,dMin:.5,dMax:6,act:'tail'},
  tarpon:{kind:'fish',len:1.8,h:.42,w:.22,back:'#46626f',belly:'#eef3f5',fin:'#57707c',level:'mid',speed:1.2,school:[3,7],spread:4.5,dMin:1.5,dMax:14,act:'roll'},
  barracuda:{kind:'fish',len:1.3,h:.16,w:.13,back:'#4f5f66',belly:'#e4eaec',fin:'#2b3338',pattern:'spots',level:'surface',speed:.6,school:[1,1],spread:0,dMin:.6,dMax:20},
  snook:{kind:'fish',len:.85,h:.19,w:.13,back:'#8a8461',belly:'#ecebdf',fin:'#c9b860',pattern:'line',level:'mid',speed:1.1,school:[2,4],spread:2.2,dMin:.8,dMax:9},
  redfish:{kind:'fish',len:.8,h:.22,w:.14,back:'#a8653a',belly:'#efd9c4',fin:'#8c4f2c',pattern:'spot',level:'mid',speed:1,school:[2,4],spread:2.2,dMin:.4,dMax:5,act:'tail'},
  trout:{kind:'fish',len:.55,h:.13,w:.09,back:'#6d7a6a',belly:'#e8ece4',fin:'#8a8f78',pattern:'spots',level:'mid',speed:1.2,school:[3,6],spread:2.2,dMin:.6,dMax:6},
  mangrove:{kind:'fish',len:.42,h:.14,w:.08,back:'#7b4b40',belly:'#d9b3a7',fin:'#a2584a',level:'mid',speed:1.1,school:[6,12],spread:2.8,dMin:1.5,dMax:20},
  yellowtail:{kind:'fish',len:.42,h:.12,w:.07,back:'#5f7aa0',belly:'#e8eef4',fin:'#f2cc2f',pattern:'yline',level:'mid',speed:1.5,school:[8,14],spread:3.2,dMin:2,dMax:40},
  mutton:{kind:'fish',len:.65,h:.22,w:.11,back:'#7a6b4e',belly:'#efcfc4',fin:'#d3684f',level:'bottom',speed:.9,school:[1,3],spread:2,dMin:2,dMax:40},
  hogfish:{kind:'fish',len:.6,h:.27,w:.11,back:'#d68f73',belly:'#f5ddd2',fin:'#b25e45',level:'bottom',speed:.8,school:[1,2],spread:2,dMin:2.5,dMax:40},
  grouper:{kind:'fish',len:1.15,h:.38,w:.3,back:'#4c4a43',belly:'#8c8778',fin:'#3a3833',pattern:'mottle',level:'bottom',speed:.5,school:[1,1],spread:0,dMin:3,dMax:60},
  parrotfish:{kind:'fish',len:.55,h:.2,w:.12,back:'#2f8f8a',belly:'#7fd3c3',fin:'#d26aa0',pattern:'mottle',level:'bottom',speed:.9,school:[2,5],spread:2.5,dMin:2,dMax:30},
  angelfish:{kind:'fish',len:.38,h:.4,w:.06,back:'#2c5fa8',belly:'#e8c33a',fin:'#f2d23b',level:'mid',speed:.7,school:[1,2],spread:1,dMin:2,dMax:30},
  mahi:{kind:'fish',len:1.25,h:.36,w:.14,back:'#2f8f6a',belly:'#e3d24a',fin:'#2a6fa3',pattern:'spots',blunt:true,level:'surface',speed:2.2,school:[3,6],spread:3.5,dMin:25,dMax:1e5},
  blackfin:{kind:'fish',len:.8,h:.22,w:.18,back:'#1e2d4f',belly:'#d7dde4',fin:'#e3c64a',level:'surface',speed:3,school:[6,10],spread:3.5,dMin:25,dMax:1e5},
  wahoo:{kind:'fish',len:1.6,h:.2,w:.15,back:'#2a5d8f',belly:'#dfe8ef',fin:'#203e5c',pattern:'bars',level:'surface',speed:3.2,school:[1,2],spread:3,dMin:25,dMax:1e5},
  sailfish:{kind:'fish',len:2.4,h:.32,w:.15,back:'#21336e',belly:'#e3e8f0',fin:'#2f4ea8',sail:true,bill:.35,level:'surface',speed:2,school:[1,3],spread:6,dMin:25,dMax:1e5},
  yellowfin:{kind:'tuna',tuna:true,len:1.5,h:.36,w:.3,back:'#1b2b57',belly:'#e3e8ee',fin:'#f2c62e',finlet:'#f2c62e',sickle:.95,pattern:'ystripe',level:'surface',speed:3.2,school:[10,18],spread:5,dMin:30,dMax:1e5,act:'bust'},
  bluefin:{kind:'tuna',tuna:true,len:2.3,h:.6,w:.5,back:'#121f45',belly:'#d9dfe6',fin:'#27324e',finlet:'#e8c440',sickle:.42,pattern:'spots',level:'surface',speed:3,school:[6,12],spread:6,dMin:30,dMax:1e5,act:'bust'},
  albacore:{kind:'tuna',tuna:true,len:1,h:.26,w:.22,back:'#263559',belly:'#e6ebf1',fin:'#2c3a5c',finlet:'#d9dde2',sickle:.4,longPec:true,level:'surface',speed:3.3,school:[10,16],spread:4,dMin:30,dMax:1e5,act:'bust'},
  cobia:{kind:'fish',len:1.3,h:.22,w:.22,back:'#3b3328',belly:'#e8e2d6',fin:'#2c261f',pattern:'line',level:'mid',speed:1.1,school:[1,3],spread:3,dMin:2,dMax:80},
  amberjack:{kind:'fish',len:1.3,h:.34,w:.2,back:'#6d6a52',belly:'#dfe3e2',fin:'#c9b25a',level:'mid',speed:1.6,school:[3,7],spread:4,dMin:15,dMax:1e5},
  kingfish:{kind:'fish',len:1.4,h:.2,w:.15,back:'#3d5a7a',belly:'#e8eef2',fin:'#334d68',level:'surface',speed:3,school:[2,5],spread:5,dMin:12,dMax:1e5},
  cero:{kind:'fish',len:.7,h:.14,w:.09,back:'#3f6286',belly:'#eef2f5',fin:'#c9b25a',pattern:'gspots',level:'surface',speed:2.2,school:[3,6],spread:3,dMin:4,dMax:60},
  jackcrevalle:{kind:'fish',len:.85,h:.32,w:.14,back:'#4f6a6e',belly:'#e6e4c6',fin:'#d9bd4a',level:'mid',speed:2,school:[4,9],spread:4,dMin:1,dMax:40},
  ladyfish:{kind:'fish',len:.6,h:.12,w:.08,back:'#7f9aa0',belly:'#eef3f4',fin:'#a8b8bd',level:'surface',speed:1.8,school:[4,10],spread:4,dMin:.5,dMax:7},
  sheepshead:{kind:'fish',len:.55,h:.3,w:.1,back:'#c9c9c0',belly:'#eeeeea',fin:'#3a3a38',pattern:'bars',level:'bottom',speed:.8,school:[2,6],spread:2.5,dMin:2,dMax:20},
  pompano:{kind:'fish',len:.42,h:.2,w:.07,back:'#9aa9ad',belly:'#f1e9b0',fin:'#e5c84a',level:'mid',speed:1.6,school:[3,7],spread:3,dMin:.8,dMax:8},
  tripletail:{kind:'fish',len:.65,h:.32,w:.12,back:'#4e4434',belly:'#6b5e47',fin:'#3b3226',pattern:'mottle',level:'surface',speed:.3,school:[1,1],spread:0,dMin:2,dMax:1e5},
  lionfish:{kind:'fish',len:.35,h:.2,w:.1,back:'#a5432e',belly:'#f2e3d6',fin:'#c25a40',pattern:'wbars',level:'bottom',speed:.4,school:[1,2],spread:1.5,dMin:3,dMax:60},
  goliath:{kind:'fish',len:2.2,h:.8,w:.62,back:'#6b5c3e',belly:'#9a8a64',fin:'#5a4d33',pattern:'mottle',level:'bottom',speed:.3,school:[1,1],spread:0,dMin:4,dMax:60},
  graytrigger:{kind:'fish',len:.45,h:.26,w:.08,back:'#6f6f68',belly:'#a8a79d',fin:'#5d5d56',level:'mid',speed:.7,school:[1,3],spread:2,dMin:3,dMax:1e5},
  bullshark:{kind:'shark',len:2.3,h:.46,w:.46,back:'#6b6f68',belly:'#eceeea',fin:'#5f635c',level:'mid',speed:1.3,school:[1,1],spread:0,dMin:1.5,dMax:40},
  lemonshark:{kind:'shark',len:2.3,h:.38,w:.38,back:'#a6976b',belly:'#e8e2c6',fin:'#9a8a5f',level:'mid',speed:1.2,school:[1,2],spread:4,dMin:.8,dMax:20},
  hammerhead:{kind:'shark',len:3.3,h:.5,w:.5,back:'#6e7a80',belly:'#eef0f1',fin:'#5e6a70',level:'mid',speed:1.4,school:[1,1],spread:0,dMin:6,dMax:1e5},
  marlin:{kind:'fish',len:3.3,h:.52,w:.36,back:'#1b2f6e',belly:'#e6ebf2',fin:'#253f8a',pattern:'lbars',bill:.3,level:'surface',speed:2.2,school:[1,1],spread:0,dMin:40,dMax:1e5},
  blackmarlin:{kind:'fish',len:3.6,h:.62,w:.42,back:'#20262f',belly:'#dfe4ea',fin:'#2a313b',bill:.28,level:'surface',speed:2.1,school:[1,1],spread:0,dMin:40,dMax:1e5},
  gag:{kind:'fish',len:.9,h:.26,w:.2,back:'#5d5a52',belly:'#a49e90',fin:'#45423c',pattern:'mottle',level:'bottom',speed:.55,school:[1,1],spread:0,dMin:3,dMax:60},
  redgrouper:{kind:'fish',len:.75,h:.25,w:.2,back:'#8a4a38',belly:'#c79a86',fin:'#6c3a2c',pattern:'spots',level:'bottom',speed:.5,school:[1,1],spread:0,dMin:3,dMax:60},
  swordfish:{kind:'fish',len:2.6,h:.45,w:.3,back:'#3a3446',belly:'#a9a4ae',fin:'#2c2834',bill:.6,level:'mid',speed:1.5,school:[1,1],spread:0,dMin:40,dMax:1e5},
  flyingfish:{kind:'fish',len:.32,h:.06,w:.05,back:'#2d4f8f',belly:'#dfe6f2',fin:'#9fb6dd',wings:true,level:'surface',speed:2.5,school:[4,9],spread:3,dMin:25,dMax:1e5,act:'glide'},
  blacktip:{kind:'shark',len:1.7,h:.28,w:.28,back:'#7a8187',belly:'#eef0f1',fin:'#2a2e32',level:'mid',speed:1.6,school:[1,2],spread:5,dMin:.6,dMax:20},
  nurse:{kind:'shark',len:2.2,h:.3,w:.38,back:'#8a7556',belly:'#c9b89a',fin:'#7a6548',level:'bottom',speed:.4,school:[1,1],spread:0,dMin:2,dMax:30},
  stingray:{kind:'ray',len:1,wing:1.1,back:'#8a7b62',belly:'#f0ebe0',level:'bottom',speed:.5,school:[1,2],spread:2.5,dMin:.4,dMax:10},
  eagleray:{kind:'ray',len:1.1,wing:2.3,back:'#2b2f38',belly:'#f2f2f2',pattern:'dots',flap:true,level:'mid',speed:1.2,school:[1,3],spread:4,dMin:1.5,dMax:25},
  turtle:{kind:'turtle',len:1,back:'#7b5a34',belly:'#d8c08a',pattern:'mottle',level:'mid',speed:.7,school:[1,1],spread:0,dMin:2,dMax:80,act:'breathe'},
  manatee:{kind:'manatee',len:3,back:'#7d8384',belly:'#9aa0a0',level:'mid',speed:.35,school:[1,2],spread:4,dMin:1,dMax:6,act:'breathe'},
  dolphin:{kind:'dolphin',len:2.4,back:'#646d78',belly:'#d9dde2',level:'surface',speed:3,school:[3,6],spread:4.5,dMin:3,dMax:1e5,act:'porpoise'}
};

/**
 * Per-habitat ambient-life tables, keyed primarily by `Zone` (@keysrun/shared/world/depth) but
 * with two extra keys — `ReefWall` and `Humps` — that are *not* zone names. `zoneAt` only ever
 * returns the seven `Zone` strings; `ReefWall`/`Humps` are a finer habitat split that
 * apps/client/src/entities/fish/spawn.ts layers on top of `zoneAt` using depth (the reef crest vs.
 * the 3.4->45.4 m wall drop) and proximity to a named `HUMPS` structure, so this table can tell
 * "shallow patch reef" apart from "ledge/drop" and "real offshore structure" apart from "open
 * water" without changing `zoneAt`'s return type or touching `packages/shared/src/world` at all.
 * See docs/ARCHITECTURE.md's depth-band table and "The Humps" in the task brief.
 */
export const ZONE_LIFE: Record<string, Array<[string, number]>> = {
  // Mangrove creek channels — juveniles sheltering along the edges.
  'Creek':[['snook',3],['redfish',2.5],['tarpon',1.5],['manatee',1],['mangrove',3.5],['ladyfish',2.5],['trout',1.5],['jackcrevalle',1]],
  // Very shallow skinny water — bonefish/permit on the sand, small sharks cruising the edges.
  'Flats':[['bonefish',5],['permit',2.2],['stingray',3],['redfish',1.5],['barracuda',2],['blacktip',1.5],['lemonshark',1],['eagleray',1],['ladyfish',3],['pompano',1.2]],
  // Florida Bay backcountry — juvenile snapper, small barracuda, rays on the sand, baitfish schools.
  'Backcountry':[['redfish',4],['snook',3],['trout',3],['mangrove',2.5],['tarpon',2],['bonefish',1.5],['permit',1],['barracuda',1.2],['manatee',1.2],['stingray',2.2],['jackcrevalle',2],['ladyfish',3],['pompano',1.5],['tripletail',.6]],
  // Bridge pilings and the channels that run under them — structure-holders in current.
  'Bridge':[['tarpon',5],['snook',2],['mangrove',3],['eagleray',1],['sheepshead',3],['goliath',.6],['jackcrevalle',1.5],['nurse',1],['cobia',1],['barracuda',1]],
  // Mixed mid-water schools, mackerel and jacks between the Bay and the reef line.
  'Hawk Channel':[['mangrove',4],['eagleray',2],['turtle',1.5],['barracuda',2],['nurse',1.5],['mutton',2],['dolphin',1],['cero',2],['pompano',1.5],['cobia',1],['graytrigger',1.2],['jackcrevalle',1.8],['yellowtail',1.5],['sheepshead',1.2]],
  // Patch reef / Sombrero crest — the existing shallow reef life (depthAt < REEF_WALL_DEPTH).
  'Reef':[['yellowtail',5],['parrotfish',3],['angelfish',2],['hogfish',2],['grouper',2],['gag',1.2],['redgrouper',1.2],['nurse',1],['turtle',1.5],['barracuda',1.5],['mutton',2],['lionfish',1.5],['graytrigger',2],['cero',2],['goliath',.4]],
  // The reef wall's ledges and drop-off (depthAt >= REEF_WALL_DEPTH, spawn.ts) — grouper holding on
  // ledges, bigger snapper/jack schools working the drop.
  'ReefWall':[['grouper',3],['gag',2],['redgrouper',2],['yellowtail',4],['mutton',2.5],['amberjack',2],['kingfish',1.5],['cero',1.5],['nurse',1],['goliath',.6],['graytrigger',1.2],['lionfish',1],['hammerhead',.3],['cobia',1]],
  // Gulf Stream / open offshore — pelagics (roaming layer only; see spawn.ts).
  'Offshore':[['mahi',5],['flyingfish',4],['dolphin',2],['blackfin',3],['sailfish',1.5],['wahoo',1],['turtle',.8],['marlin',.6],['blackmarlin',.25],['swordfish',.3],['yellowfin',2.5],['albacore',1.2],['bluefin',.8],['kingfish',1.5],['amberjack',1.5],['hammerhead',.3]],
  // The Humps (Marathon Hump, West Hump) and other named structure far offshore — real relief that
  // concentrates bottom fish and jacks well out in otherwise-open water.
  'Humps':[['amberjack',4],['grouper',2.5],['gag',1.5],['redgrouper',1.5],['cobia',2],['mutton',2],['yellowtail',2],['kingfish',1.5],['barracuda',1.5],['goliath',.5],['bullshark',.4],['nurse',1]]
};

/** [startU, endU, heightScale, finStyle] along the body, used by finEdge/buildFishGeo. */
export type FinSpec = [number, number, number, string];

export interface FishShape {
  peak: number;
  nose: number;
  ped: number;
  tail: string;
  tl: number;
  th: number;
  dor: FinSpec[];
  anal: FinSpec[];
  pec: number;
  belly?: number;
  hump?: number;
  finlets?: boolean;
  shark?: boolean;
  wings?: boolean;
}

export const SHAPE: Record<string, FishShape> = {
  bonefish:{peak:.38,nose:1,ped:.17,tail:'fork',tl:.24,th:.5,dor:[[.33,.48,.55,'tri']],anal:[[.7,.78,.22,'tri']],pec:.15,belly:.9},
  permit:{peak:.42,nose:.42,ped:.11,tail:'fork',tl:.34,th:.62,dor:[[.4,.72,.32,'sickle']],anal:[[.46,.74,.34,'sickle']],pec:.16},
  tarpon:{peak:.38,nose:.75,ped:.16,tail:'deepfork',tl:.26,th:.6,dor:[[.43,.56,.55,'sickle']],anal:[[.62,.78,.32,'tri']],pec:.12},
  barracuda:{peak:.52,nose:1.5,ped:.26,tail:'fork',tl:.18,th:.75,dor:[[.3,.38,.38,'tri'],[.64,.71,.42,'tri']],anal:[[.65,.72,.38,'tri']],pec:.09},
  snook:{peak:.34,nose:1,ped:.22,tail:'fork',tl:.2,th:.6,dor:[[.3,.45,.55,'spiny'],[.5,.66,.4,'round']],anal:[[.67,.75,.35,'tri']],pec:.12},
  redfish:{peak:.38,nose:.75,ped:.26,tail:'truncate',tl:.17,th:.55,dor:[[.28,.43,.42,'spiny'],[.45,.72,.3,'long']],anal:[[.66,.77,.3,'round']],pec:.14},
  trout:{peak:.36,nose:1,ped:.22,tail:'truncate',tl:.18,th:.6,dor:[[.3,.42,.45,'spiny'],[.45,.72,.3,'long']],anal:[[.64,.78,.25,'long']],pec:.12},
  mangrove:{peak:.38,nose:.8,ped:.2,tail:'fork',tl:.22,th:.55,dor:[[.3,.74,.32,'spiny']],anal:[[.64,.77,.3,'round']],pec:.15},
  yellowtail:{peak:.36,nose:.9,ped:.15,tail:'fork',tl:.32,th:.85,dor:[[.32,.74,.28,'spiny']],anal:[[.64,.76,.25,'tri']],pec:.15},
  mutton:{peak:.4,nose:.75,ped:.2,tail:'fork',tl:.22,th:.55,dor:[[.3,.75,.32,'spiny']],anal:[[.64,.78,.35,'tri']],pec:.16},
  hogfish:{peak:.42,nose:.55,ped:.24,tail:'lyre',tl:.24,th:.6,dor:[[.18,.3,.85,'filament'],[.3,.76,.3,'long']],anal:[[.55,.78,.3,'long']],pec:.14,hump:.25},
  grouper:{peak:.4,nose:.6,ped:.32,tail:'round',tl:.17,th:.5,dor:[[.28,.78,.25,'spiny']],anal:[[.64,.8,.28,'round']],pec:.18,belly:1.05},
  parrotfish:{peak:.42,nose:.55,ped:.28,tail:'truncate',tl:.18,th:.6,dor:[[.25,.8,.22,'long']],anal:[[.6,.8,.22,'long']],pec:.16},
  angelfish:{peak:.45,nose:.5,ped:.22,tail:'truncate',tl:.2,th:.55,dor:[[.32,.85,.35,'trail']],anal:[[.45,.85,.35,'trail']],pec:.14},
  mahi:{peak:.12,nose:.32,ped:.1,tail:'fork',tl:.3,th:.65,dor:[[.05,.88,.32,'long']],anal:[[.48,.88,.25,'long']],pec:.12,hump:.35},
  blackfin:{peak:.43,nose:.9,ped:.06,tail:'lunate',tl:.24,th:1.2,dor:[[.3,.4,.4,'tri'],[.52,.58,.35,'sickle']],anal:[[.54,.6,.35,'sickle']],pec:.2,finlets:true},
  yellowfin:{peak:.43,nose:.9,ped:.06,tail:'lunate',tl:.26,th:1.25,dor:[[.3,.4,.42,'tri']],anal:[],pec:.2,finlets:true},
  bluefin:{peak:.43,nose:.9,ped:.06,tail:'lunate',tl:.22,th:1.05,dor:[[.3,.4,.38,'tri']],anal:[],pec:.14,finlets:true},
  albacore:{peak:.43,nose:.9,ped:.06,tail:'lunate',tl:.24,th:1.2,dor:[[.3,.4,.4,'tri']],anal:[],pec:.42,finlets:true},
  wahoo:{peak:.46,nose:1.6,ped:.14,tail:'lunate',tl:.15,th:1.1,dor:[[.12,.58,.22,'long']],anal:[[.58,.66,.25,'tri']],pec:.08,finlets:true},
  sailfish:{peak:.34,nose:1.2,ped:.1,tail:'lunate',tl:.18,th:1.3,dor:[[.12,.78,1.9,'sail']],anal:[[.6,.68,.4,'sickle']],pec:.12},
  marlin:{peak:.36,nose:1,ped:.1,tail:'lunate',tl:.2,th:1.3,dor:[[.14,.6,.75,'sickle']],anal:[[.58,.66,.45,'sickle']],pec:.16},
  blackmarlin:{peak:.35,nose:1,ped:.1,tail:'lunate',tl:.21,th:1.3,dor:[[.14,.5,.45,'sickle']],anal:[[.58,.66,.42,'sickle']],pec:.24},
  gag:{peak:.42,nose:.65,ped:.28,tail:'truncate',tl:.15,th:.5,dor:[[.28,.8,.22,'spiny']],anal:[[.64,.8,.24,'round']],pec:.17},
  redgrouper:{peak:.42,nose:.6,ped:.3,tail:'round',tl:.16,th:.5,dor:[[.28,.78,.26,'spiny']],anal:[[.64,.8,.26,'round']],pec:.18,belly:1.05},
  swordfish:{peak:.36,nose:.95,ped:.1,tail:'lunate',tl:.2,th:1.25,dor:[[.2,.32,.8,'sickle']],anal:[[.6,.66,.35,'sickle']],pec:.15},
  flyingfish:{peak:.38,nose:.9,ped:.18,tail:'fork',tl:.3,th:.9,dor:[[.62,.72,.3,'tri']],anal:[[.62,.72,.3,'tri']],pec:1.05,wings:true},
  blacktip:{peak:.38,nose:1.3,ped:.12,tail:'hetero',tl:.26,th:1,dor:[[.33,.46,.9,'sickle'],[.7,.75,.25,'tri']],anal:[[.72,.77,.2,'tri']],pec:.55,shark:true},
  nurse:{peak:.3,nose:.6,ped:.2,tail:'hetero',tl:.3,th:.7,dor:[[.55,.64,.5,'round'],[.7,.77,.4,'round']],anal:[[.7,.76,.25,'round']],pec:.35,shark:true,belly:.7},
  cobia:{peak:.32,nose:1,ped:.18,tail:'fork',tl:.2,th:.7,dor:[[.32,.42,.15,'spiny'],[.48,.7,.35,'sickle']],anal:[[.55,.72,.3,'sickle']],pec:.16,belly:.9},
  amberjack:{peak:.38,nose:.75,ped:.12,tail:'fork',tl:.26,th:.85,dor:[[.4,.72,.35,'sickle']],anal:[[.55,.72,.3,'sickle']],pec:.12},
  kingfish:{peak:.4,nose:1.4,ped:.12,tail:'lunate',tl:.18,th:1.15,dor:[[.18,.38,.22,'spiny'],[.48,.58,.3,'tri']],anal:[[.56,.64,.3,'tri']],pec:.1,finlets:true},
  cero:{peak:.4,nose:1.3,ped:.12,tail:'lunate',tl:.2,th:1.1,dor:[[.2,.4,.25,'spiny'],[.48,.58,.3,'tri']],anal:[[.56,.64,.3,'tri']],pec:.1,finlets:true},
  jackcrevalle:{peak:.36,nose:.5,ped:.1,tail:'fork',tl:.3,th:.75,dor:[[.32,.4,.3,'tri'],[.44,.74,.3,'sickle']],anal:[[.52,.74,.28,'sickle']],pec:.22,hump:.15},
  ladyfish:{peak:.42,nose:1.2,ped:.16,tail:'fork',tl:.3,th:.8,dor:[[.42,.54,.5,'tri']],anal:[[.7,.78,.25,'tri']],pec:.1},
  sheepshead:{peak:.4,nose:.55,ped:.22,tail:'fork',tl:.18,th:.5,dor:[[.25,.78,.3,'spiny']],anal:[[.6,.78,.3,'round']],pec:.16,hump:.12},
  pompano:{peak:.42,nose:.4,ped:.1,tail:'fork',tl:.32,th:.85,dor:[[.48,.72,.35,'sickle']],anal:[[.5,.72,.35,'sickle']],pec:.14},
  tripletail:{peak:.42,nose:.6,ped:.3,tail:'round',tl:.16,th:.55,dor:[[.3,.78,.35,'round']],anal:[[.55,.8,.38,'round']],pec:.14},
  lionfish:{peak:.38,nose:.6,ped:.25,tail:'round',tl:.2,th:.6,dor:[[.2,.6,1.4,'spiny'],[.62,.8,.6,'round']],anal:[[.62,.8,.5,'round']],pec:.75,wings:true},
  goliath:{peak:.42,nose:.55,ped:.32,tail:'round',tl:.16,th:.45,dor:[[.3,.8,.22,'spiny']],anal:[[.65,.82,.25,'round']],pec:.18,belly:1.08},
  graytrigger:{peak:.42,nose:.55,ped:.2,tail:'lyre',tl:.2,th:.55,dor:[[.25,.33,.5,'tri'],[.48,.78,.35,'sickle']],anal:[[.5,.78,.35,'sickle']],pec:.12},
  bullshark:{peak:.36,nose:.8,ped:.12,tail:'hetero',tl:.26,th:1,dor:[[.32,.44,.8,'sickle'],[.7,.75,.25,'tri']],anal:[[.72,.77,.2,'tri']],pec:.5,shark:true},
  lemonshark:{peak:.38,nose:1,ped:.12,tail:'hetero',tl:.26,th:1,dor:[[.36,.47,.6,'sickle'],[.6,.7,.55,'sickle']],anal:[[.68,.74,.25,'tri']],pec:.5,shark:true},
  hammerhead:{peak:.38,nose:1.2,ped:.1,tail:'hetero',tl:.3,th:1.1,dor:[[.3,.42,1.5,'sickle'],[.72,.76,.3,'tri']],anal:[[.72,.77,.3,'tri']],pec:.4,shark:true},
  dolphin:{peak:.38,nose:.7,ped:.14,tail:'flukes',tl:.2,th:1,dor:[[.42,.55,.7,'sickle']],anal:[],pec:.2,hump:.18}
};
