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
  /**
   * Lies flat on the bottom rather than swimming upright: a flatfish. The body is authored
   * upright like every other fish (a deep `h`, a very thin `w`) and rolled a quarter turn at
   * render time — see entities/fish/school.ts. That is what a flounder anatomically IS, so the
   * dorsal and anal fins become the fringe down its two long edges and the baked swim bend
   * sweeps in the vertical plane, which is how a flatfish actually undulates, both for free.
   */
  flat?: boolean;
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
  /**
   * Explicit tier-1 "decoration" marker (docs/ARCHITECTURE.md "Fish ownership — three tiers":
   * "Species with `catchable: false` have no server representation at all"). Absent or `true`
   * means an ordinary catchable fish — every such key also has a matching entry in `SPECIES`/
   * `ZONE_TABLE` (content/species.ts). `false` marks a creature that must never be rollable by
   * rod (`sim/fight.ts`'s `pickSpecies`, which filters on `isCatchable` below) or hittable by
   * spear (`sim/spear.ts`'s `stepSpear`, via a `CapsuleTarget.catchable` built by
   * `capsuleFromSpecies`) — marine mammals (dolphins, whales, manatees) today. This is the single
   * source of truth both paths consult, expressed as data rather than a `species === 'dolphin'`
   * branch scattered through fishing/spearfishing code — see `test/catchable.test.ts`.
   */
  catchable?: boolean;
}

export const VIS: Record<string, CreatureVis> = {
  bonefish:{kind:'fish',len:.65,h:.15,w:.11,back:'#6f8a82',belly:'#e3ebe8',fin:'#9fb1aa',level:'mid',speed:1.4,school:[5,15],spread:2.4,dMin:.35,dMax:4,act:'tail'},
  permit:{kind:'fish',len:.75,h:.42,w:.1,back:'#5e6f78',belly:'#d9e1e4',fin:'#22282d',level:'mid',speed:1.3,school:[2,7],spread:2.6,dMin:.5,dMax:6,act:'tail'},
  tarpon:{kind:'fish',len:1.8,h:.42,w:.22,back:'#46626f',belly:'#eef3f5',fin:'#57707c',level:'mid',speed:1.2,school:[6,18],spread:4.5,dMin:1.5,dMax:14,act:'roll'},
  barracuda:{kind:'fish',len:1.3,h:.16,w:.13,back:'#4f5f66',belly:'#e4eaec',fin:'#2b3338',pattern:'blotch',level:'surface',speed:.6,school:[1,1],spread:0,dMin:.6,dMax:20},
  snook:{kind:'fish',len:.85,h:.19,w:.13,back:'#8a8461',belly:'#ecebdf',fin:'#c9b860',pattern:'line',level:'mid',speed:1.1,school:[2,4],spread:2.2,dMin:.8,dMax:9},
  redfish:{kind:'fish',len:.8,h:.22,w:.14,back:'#a8653a',belly:'#efd9c4',fin:'#8c4f2c',pattern:'spot',level:'mid',speed:1,school:[3,10],spread:2.2,dMin:.4,dMax:5,act:'tail'},
  trout:{kind:'fish',len:.55,h:.13,w:.09,back:'#6d7a6a',belly:'#e8ece4',fin:'#8a8f78',pattern:'spots',level:'mid',speed:1.2,school:[4,12],spread:2.2,dMin:.6,dMax:6},
  mangrove:{kind:'fish',len:.42,h:.14,w:.08,back:'#7b4b40',belly:'#d9b3a7',fin:'#a2584a',level:'mid',speed:1.1,school:[9,22],spread:2.8,dMin:1.5,dMax:20},
  yellowtail:{kind:'fish',len:.42,h:.12,w:.07,back:'#5f7aa0',belly:'#e8eef4',fin:'#f2cc2f',pattern:'yline',level:'mid',speed:1.5,school:[14,30],spread:3.2,dMin:2,dMax:40},
  mutton:{kind:'fish',len:.65,h:.22,w:.11,back:'#7a6b4e',belly:'#efcfc4',fin:'#d3684f',pattern:'spot',level:'bottom',speed:.9,school:[1,3],spread:2,dMin:2,dMax:40},
  hogfish:{kind:'fish',len:.6,h:.27,w:.11,back:'#d68f73',belly:'#f5ddd2',fin:'#b25e45',level:'bottom',speed:.8,school:[1,2],spread:2,dMin:2.5,dMax:40},
  grouper:{kind:'fish',len:1.15,h:.38,w:.3,back:'#4c4a43',belly:'#8c8778',fin:'#3a3833',pattern:'mottle',level:'bottom',speed:.5,school:[1,1],spread:0,dMin:3,dMax:120},
  parrotfish:{kind:'fish',len:.55,h:.2,w:.12,back:'#2f8f8a',belly:'#7fd3c3',fin:'#d26aa0',pattern:'mottle',level:'bottom',speed:.9,school:[2,5],spread:2.5,dMin:2,dMax:30},
  angelfish:{kind:'fish',len:.38,h:.4,w:.06,back:'#2c5fa8',belly:'#e8c33a',fin:'#f2d23b',level:'mid',speed:.7,school:[1,2],spread:1,dMin:2,dMax:30},
  mahi:{kind:'fish',len:1.25,h:.36,w:.14,back:'#2f8f6a',belly:'#e3d24a',fin:'#2a6fa3',pattern:'spots',blunt:true,level:'surface',speed:2.2,school:[5,22],spread:3.5,dMin:25,dMax:1e5},
  blackfin:{kind:'fish',len:.8,h:.22,w:.18,back:'#1e2d4f',belly:'#d7dde4',fin:'#e3c64a',level:'surface',speed:3,school:[14,34],spread:3.5,dMin:25,dMax:1e5},
  wahoo:{kind:'fish',len:1.6,h:.2,w:.15,back:'#2a5d8f',belly:'#dfe8ef',fin:'#203e5c',pattern:'bars',level:'surface',speed:3.2,school:[1,2],spread:3,dMin:25,dMax:1e5},
  sailfish:{kind:'fish',len:2.4,h:.32,w:.15,back:'#21336e',belly:'#e3e8f0',fin:'#2f4ea8',sail:true,bill:.35,level:'surface',speed:2,school:[1,3],spread:6,dMin:25,dMax:1e5},
  yellowfin:{kind:'tuna',tuna:true,len:1.5,h:.36,w:.3,back:'#1b2b57',belly:'#e3e8ee',fin:'#f2c62e',finlet:'#f2c62e',sickle:.95,pattern:'ystripe',level:'surface',speed:3.2,school:[10,18],spread:5,dMin:30,dMax:1e5,act:'bust'},
  bluefin:{kind:'tuna',tuna:true,len:2.3,h:.6,w:.5,back:'#121f45',belly:'#d9dfe6',fin:'#27324e',finlet:'#e8c440',sickle:.42,pattern:'spots',level:'surface',speed:3,school:[6,12],spread:6,dMin:30,dMax:1e5,act:'bust'},
  albacore:{kind:'tuna',tuna:true,len:1,h:.26,w:.22,back:'#263559',belly:'#e6ebf1',fin:'#2c3a5c',finlet:'#d9dde2',sickle:.4,longPec:true,level:'surface',speed:3.3,school:[10,16],spread:4,dMin:30,dMax:1e5,act:'bust'},
  cobia:{kind:'fish',len:1.3,h:.22,w:.22,back:'#3b3328',belly:'#e8e2d6',fin:'#2c261f',pattern:'line',level:'mid',speed:1.1,school:[1,3],spread:3,dMin:2,dMax:80},
  amberjack:{kind:'fish',len:1.3,h:.34,w:.2,back:'#6d6a52',belly:'#dfe3e2',fin:'#c9b25a',level:'mid',speed:1.6,school:[5,18],spread:4,dMin:15,dMax:1e5},
  kingfish:{kind:'fish',len:1.4,h:.2,w:.15,back:'#3d5a7a',belly:'#e8eef2',fin:'#334d68',level:'surface',speed:3,school:[3,9],spread:5,dMin:12,dMax:1e5},
  cero:{kind:'fish',len:.7,h:.14,w:.09,back:'#3f6286',belly:'#eef2f5',fin:'#c9b25a',pattern:'gspots',level:'surface',speed:2.2,school:[3,8],spread:3,dMin:4,dMax:60},
  jackcrevalle:{kind:'fish',len:.85,h:.32,w:.14,back:'#4f6a6e',belly:'#e6e4c6',fin:'#d9bd4a',pattern:'gillspot',level:'mid',speed:2,school:[8,24],spread:4,dMin:1,dMax:40},
  ladyfish:{kind:'fish',len:.6,h:.12,w:.08,back:'#7f9aa0',belly:'#eef3f4',fin:'#a8b8bd',level:'surface',speed:1.8,school:[8,20],spread:4,dMin:.5,dMax:7},
  // Deep and extremely thin (h 10x w) because that is a flatfish seen head-on, plus `flat` to
  // lay it over. `belly` is near-white: a flounder's underside is the blind side and unpigmented.
  flounder:{kind:'fish',len:.5,h:.3,w:.055,back:'#6b5f4a',belly:'#efe9dd',fin:'#5e5342',pattern:'spot',flat:true,level:'bottom',speed:.45,school:[1,2],spread:2.2,dMin:.5,dMax:14},
  // The other two flatfish. Same construction as the flounder above — authored deep and very
  // thin, `flat` lays it over — and the same rule about the blind underside being unpigmented.
  // A sole is a small rounded thing that buries itself in estuary mud; a halibut is the biggest
  // flatfish there is and lives out where it is deep and cold, which is why `dMin` is so far down.
  sole:{kind:'fish',len:.26,h:.17,w:.03,back:'#5e5444',belly:'#efe9dd',fin:'#4e4639',pattern:'blotch',flat:true,level:'bottom',speed:.38,school:[1,3],spread:1.8,dMin:.5,dMax:18},
  halibut:{kind:'fish',len:1.25,h:.72,w:.13,back:'#4a4a44',belly:'#f0ece2',fin:'#3e3e39',pattern:'blotch',flat:true,level:'bottom',speed:.6,school:[1,1],spread:0,dMin:18,dMax:240},
  sheepshead:{kind:'fish',len:.55,h:.3,w:.1,back:'#c9c9c0',belly:'#eeeeea',fin:'#3a3a38',pattern:'bars',level:'bottom',speed:.8,school:[2,6],spread:2.5,dMin:2,dMax:20},
  pompano:{kind:'fish',len:.42,h:.2,w:.07,back:'#9aa9ad',belly:'#f1e9b0',fin:'#e5c84a',level:'mid',speed:1.6,school:[6,16],spread:3,dMin:.8,dMax:8},
  tripletail:{kind:'fish',len:.65,h:.32,w:.12,back:'#4e4434',belly:'#6b5e47',fin:'#3b3226',pattern:'mottle',level:'surface',speed:.3,school:[1,1],spread:0,dMin:2,dMax:1e5},
  lionfish:{kind:'fish',len:.35,h:.2,w:.1,back:'#a5432e',belly:'#f2e3d6',fin:'#c25a40',pattern:'wbars',level:'bottom',speed:.4,school:[1,2],spread:1.5,dMin:3,dMax:60},
  goliath:{kind:'fish',len:2.2,h:.8,w:.62,back:'#6b5c3e',belly:'#9a8a64',fin:'#5a4d33',pattern:'mottle',level:'bottom',speed:.3,school:[1,1],spread:0,dMin:4,dMax:60},
  graytrigger:{kind:'fish',len:.45,h:.26,w:.08,back:'#6f6f68',belly:'#a8a79d',fin:'#5d5d56',pattern:'mottle',level:'mid',speed:.7,school:[2,8],spread:2,dMin:3,dMax:1e5},
  bullshark:{kind:'shark',len:2.3,h:.46,w:.46,back:'#6b6f68',belly:'#eceeea',fin:'#5f635c',level:'mid',speed:1.3,school:[1,1],spread:0,dMin:1.5,dMax:40},
  lemonshark:{kind:'shark',len:2.3,h:.38,w:.38,back:'#a6976b',belly:'#e8e2c6',fin:'#9a8a5f',level:'mid',speed:1.2,school:[1,2],spread:4,dMin:.8,dMax:20},
  hammerhead:{kind:'shark',len:3.3,h:.5,w:.5,back:'#6e7a80',belly:'#eef0f1',fin:'#5e6a70',level:'mid',speed:1.4,school:[1,1],spread:0,dMin:6,dMax:1e5},
  marlin:{kind:'fish',len:3.3,h:.52,w:.36,back:'#1b2f6e',belly:'#e6ebf2',fin:'#253f8a',pattern:'lbars',bill:.3,level:'surface',speed:2.2,school:[1,1],spread:0,dMin:40,dMax:1e5},
  blackmarlin:{kind:'fish',len:3.6,h:.62,w:.42,back:'#20262f',belly:'#dfe4ea',fin:'#2a313b',bill:.28,level:'surface',speed:2.1,school:[1,1],spread:0,dMin:40,dMax:1e5},
  gag:{kind:'fish',len:.9,h:.26,w:.2,back:'#5d5a52',belly:'#a49e90',fin:'#45423c',pattern:'mottle',level:'bottom',speed:.55,school:[1,1],spread:0,dMin:3,dMax:120},
  redgrouper:{kind:'fish',len:.75,h:.25,w:.2,back:'#8a4a38',belly:'#c79a86',fin:'#6c3a2c',pattern:'spots',level:'bottom',speed:.5,school:[1,1],spread:0,dMin:3,dMax:120},
  swordfish:{kind:'fish',len:2.6,h:.45,w:.3,back:'#3a3446',belly:'#a9a4ae',fin:'#2c2834',bill:.6,level:'mid',speed:1.5,school:[1,1],spread:0,dMin:40,dMax:1e5},
  flyingfish:{kind:'fish',len:.32,h:.06,w:.05,back:'#2d4f8f',belly:'#dfe6f2',fin:'#9fb6dd',wings:true,level:'surface',speed:2.5,school:[10,28],spread:3,dMin:25,dMax:1e5,act:'glide'},
  blacktip:{kind:'shark',len:1.7,h:.28,w:.28,back:'#7a8187',belly:'#eef0f1',fin:'#2a2e32',level:'mid',speed:1.6,school:[1,2],spread:5,dMin:.6,dMax:20},
  nurse:{kind:'shark',len:2.2,h:.3,w:.38,back:'#8a7556',belly:'#c9b89a',fin:'#7a6548',level:'bottom',speed:.4,school:[1,1],spread:0,dMin:2,dMax:30},
  stingray:{kind:'ray',len:1,wing:1.1,back:'#8a7b62',belly:'#f0ebe0',level:'bottom',speed:.5,school:[1,2],spread:2.5,dMin:.4,dMax:10},
  eagleray:{kind:'ray',len:1.1,wing:2.3,back:'#2b2f38',belly:'#f2f2f2',pattern:'dots',flap:true,level:'mid',speed:1.2,school:[1,3],spread:4,dMin:1.5,dMax:25},
  turtle:{kind:'turtle',len:1,back:'#7b5a34',belly:'#d8c08a',pattern:'mottle',level:'mid',speed:.7,school:[1,1],spread:0,dMin:2,dMax:80,act:'breathe'},
  // Protected, non-catchable (catchable:false below) — already placed in the shallow bay/creek
  // ZONE_LIFE tables below, not offshore with the whales (see this task's brief).
  manatee:{kind:'manatee',len:3,back:'#7d8384',belly:'#9aa0a0',level:'mid',speed:.35,school:[1,2],spread:4,dMin:1,dMax:6,act:'breathe',catchable:false},
  // Bottlenose dolphin — pods of 3-8, a regular/cheering sight (Hawk Channel, the bay, the reef
  // line, the bridge; see ZONE_LIFE below), never catchable. `act:'porpoise'` (behavior.ts/
  // school.ts) is the rhythmic breaching arc; bow-riding is a separate, boat-seeking behavior
  // layered on top in school.ts (`BOW_RIDE_*` constants, behavior.ts) since it needs the boat's
  // heading, not just its position.
  dolphin:{kind:'dolphin',len:2.6,h:.34,w:.3,back:'#5b6670',belly:'#dde2e6',fin:'#43505a',level:'surface',speed:3.4,school:[3,8],spread:5,dMin:2.5,dMax:1e5,act:'porpoise',catchable:false},
  // Short-finned pilot whale — ~6 m, dark/matte, travels in small pods near real structure (the
  // Humps are a genuine Keys pilot-whale spot) and occasionally the open Gulf Stream. `hump:.5`
  // in SHAPE.pilotwhale below gives the bulbous melon forehead; `act:'blow'` is the slow
  // surface-blow/fluke-up cycle (school.ts), with a far longer act cooldown (behavior.ts's
  // ACT_CD.blow) than a dolphin's porpoise — "long dive intervals" is the whole point.
  pilotwhale:{kind:'whale',len:6,h:1.05,w:.95,back:'#2a2a2c',belly:'#3a3a3c',level:'surface',speed:2.4,school:[5,14],spread:6,dMin:12,dMax:1e5,act:'blow',catchable:false},
  // Humpback — ~15 m, must dwarf the 7 m Robalo. Rare, Gulf-Stream/offshore only. `pec:.34` +
  // `wings:true` in SHAPE.humpback below are the signature huge pectoral "wings" (up to ~1/3 body
  // length on a real humpback); `pattern:'mottle'` reads as barnacles/scarring on the dark back.
  // ---------------------------------------------------------------------------------------
  // Florida FWC "Florida Saltwater Fish" ID chart species (reference image supplied by the
  // user). Chosen for one reason above all: these are the Keys' real *schooling* fish, and the
  // world had almost none of them — every reef species already here schools in ones and twos
  // (mutton [1,3], hogfish [1,2], grouper [1,1]). Colours and proportions are read off the chart
  // plate for each species rather than invented.
  // ---------------------------------------------------------------------------------------
  // Caranx crysos — blue-green back, brassy flanks, yellow-olive forked tail, a dark opercular
  // spot. The Keys' default "wall of fish": big fast-moving schools over reef and channel.
  bluerunner:{kind:'fish',len:.5,h:.15,w:.09,back:'#43707d',belly:'#eef2f2',fin:'#cdb94e',level:'mid',speed:2,school:[12,26],spread:4.2,dMin:1.5,dMax:120},
  // Lutjanus apodus — olive-brown with eight pale vertical bars and yellow fins. Named for the
  // habit this adds to the game: it hangs over patch reef in tight groups.
  schoolmaster:{kind:'fish',len:.45,h:.16,w:.09,back:'#8a7347',belly:'#e8dcc0',fin:'#e0ac3c',pattern:'bars',level:'mid',speed:1.1,school:[8,18],spread:3,dMin:1.5,dMax:30},
  // Lutjanus synagris — rose-pink above, silver below, with horizontal yellow stripes and a
  // diffuse dark blotch under the rear dorsal.
  lanesnapper:{kind:'fish',len:.34,h:.12,w:.07,back:'#c07a68',belly:'#f2ded2',fin:'#e8c050',pattern:'yline',level:'bottom',speed:1.1,school:[7,15],spread:2.8,dMin:2,dMax:45},
  // Rhomboplites aurorubens — uniformly vermilion above, pale below. Schools hard along the
  // reef wall's drop, which is exactly the band ZONE_LIFE.ReefWall covers.
  vermilion:{kind:'fish',len:.4,h:.14,w:.08,back:'#ad3a2a',belly:'#eec6b6',fin:'#c24631',level:'mid',speed:1.3,school:[9,20],spread:3.2,dMin:8,dMax:90},
  // Selene vomer — extreme laterally-compressed silver disc with a near-vertical head profile;
  // h >> w is the whole identity of the fish. Hangs around bridge pilings and structure.
  lookdown:{kind:'fish',len:.3,h:.33,w:.045,back:'#b9c8d2',belly:'#f4f8fa',fin:'#d8e2e8',level:'mid',speed:1.2,school:[6,14],spread:2.4,dMin:1.5,dMax:25},
  // Trachinotus goodei — silver pompano-shaped body with long trailing dark dorsal/anal lobes
  // and four faint bars. Small fast schools in the surf and over the flats.
  palometa:{kind:'fish',len:.3,h:.17,w:.05,back:'#9fb0b8',belly:'#f4f0e0',fin:'#2a3038',pattern:'bars',level:'mid',speed:1.8,school:[6,13],spread:2.8,dMin:.6,dMax:12},
  // Scomberomorus maculatus — the spotted mackerel: blue-green back, silver flanks, scattered
  // round golden spots, no bars (that is how you tell it from a cero at a glance).
  spanishmack:{kind:'fish',len:.6,h:.13,w:.08,back:'#3a6b8c',belly:'#eef3f6',fin:'#2d5370',pattern:'gspots',level:'surface',speed:2.6,school:[7,16],spread:4,dMin:2,dMax:50},
  // ---------------------------------------------------------------------------------------
  // Tuna ID chart species (second reference image supplied by the user). The world already had
  // yellowfin, bluefin and albacore; these are the two it was missing.
  // ---------------------------------------------------------------------------------------
  // Thunnus obesus — deep-bodied, very large eye, dark metallic blue back, bright yellow
  // finlets edged in black. Deep-water tuna, so dMin sits well past the reef wall.
  bigeye:{kind:'tuna',tuna:true,len:1.6,h:.42,w:.34,back:'#1c3050',belly:'#e6ebf0',fin:'#27405e',finlet:'#f0c63a',sickle:.5,level:'mid',speed:3,school:[5,11],spread:5,dMin:40,dMax:1e5,act:'bust'},
  // Katsuwonus pelamis — small, torpedo-shaped, dark blue above with 4-6 bold horizontal dark
  // stripes running along a silver belly (unique among tunas; `hline` pattern below). The most
  // abundant schooling tuna there is, which is why its school range is the largest here.
  skipjack:{kind:'tuna',tuna:true,len:.75,h:.2,w:.17,back:'#23344f',belly:'#dfe6ec',fin:'#2b3a52',finlet:'#c8d0d8',sickle:.35,pattern:'hline',level:'surface',speed:3.4,school:[14,30],spread:5.5,dMin:25,dMax:1e5,act:'bust'},
  humpback:{kind:'whale',len:15,h:2.6,w:2.1,back:'#1c2430',belly:'#8f97a0',pattern:'mottle',level:'surface',speed:1.8,school:[1,2],spread:10,dMin:25,dMax:1e5,act:'blow',catchable:false},

  // ---- The big ones. Everything above is a fish you meet; these are the four you remember. ----
  //
  // Three of the four are `catchable: false`, and not as a shortcut: the whale shark and the
  // giant manta are filter feeders nobody fishes for, and the smalltooth sawfish is federally
  // endangered and illegal to target in Florida. Only the tiger shark is on a line.
  //
  // Rarity lives in the ZONE_LIFE weights below, not here. These are deliberately tiny — the
  // point of a whale shark is that you have been out there a while and then there is one.
  //
  // How tiny, in play terms (measured by test/ocean-census.test.ts: mean boat distance between
  // encounters, school counted as met inside 100 m). A one-hour session is ~35 km of track (about
  // 30% of the hour underway at 18-20 m/s; the rest is trolling, drifting and fighting fish), and a
  // month of play is ~12 such hours, ~400 km. The world is 8.3 x 8.3 km, so the encounter distance
  // is 68.9 km2 / (N schools x 0.2 km sighting width) = 344 km / N. Whale shark, great white,
  // sperm whale and sawfish are set to N=2 (170 km expected; the 152-transect sample reads 156-467 km
  // because two schools is a small sample): you meet one a few sessions in, not every
  // crossing, and N=1 (344 km) is the floor for "it exists" in a fixed-seed world. They were N=7-8
  // (35-47 km, i.e. one per crossing of the map). Giant manta, mola and humpback sit a tier up at
  // N=3-6 (50-95 km): a good session. See the Offshore / Flats / Backcountry / Humps tables.

  // Whale shark — the biggest fish in the ocean, and a real if uncommon Keys/Gulf Stream visitor.
  // 9 m here rather than a full-grown 12: it has to read as enormous beside a 7 m Robalo without
  // becoming the only thing in the frame. Slow (`speed:1.1`) because they genuinely are, surface
  // level because that is where you see them, and `pattern:'gspots'` for the white spot grid.
  whaleshark:{kind:'shark',len:9,h:1.5,w:1.6,back:'#3f4a55',belly:'#e8ecee',fin:'#35404a',pattern:'gspots',level:'surface',speed:1.1,school:[1,1],spread:0,dMin:8,dMax:1e5,catchable:false},
  // Giant manta — 5.5 m across the wings, which is wider than it is long and the whole reason to
  // look at one. `flap:true` drives the wing-beat roll (school.ts); dark above, white below.
  giantmanta:{kind:'ray',len:2.4,wing:5.5,back:'#1d2127',belly:'#f4f4f2',pattern:'spots',flap:true,level:'mid',speed:1.5,school:[1,2],spread:6,dMin:4,dMax:1e5,catchable:false},
  // Smalltooth sawfish — a Florida endemic, critically endangered, and unmistakable: the rostrum
  // is about a quarter of its length. `bill` is the billfish rostrum parameter, reused; it is the
  // right shape at this fidelity and the saw's teeth are below what the body builder resolves.
  // Backcountry and flats, in very shallow water, which is where the remaining population is.
  sawfish:{kind:'shark',len:4.2,h:.42,w:.5,back:'#8d8c7c',belly:'#e6e3d4',fin:'#7b7a6b',bill:.26,level:'bottom',speed:.6,school:[1,1],spread:0,dMin:.8,dMax:12,catchable:false},
  // Tiger shark — the one big new animal you can actually hook. Second only to the great white
  // among sharks that take a bait, and a real deep-wall/offshore Keys fish. The vertical bars
  // (`pattern:'bars'`) fade with age on a real one; they are kept here because they are what
  // makes it recognisable as a tiger and not just another grey shark.
  tigershark:{kind:'shark',len:4.2,h:.78,w:.72,back:'#5f6a63',belly:'#eceeea',fin:'#515b55',pattern:'bars',level:'mid',speed:1.5,school:[1,1],spread:0,dMin:6,dMax:1e5},

  // ---- A second batch of big ones. The first (above) was about awe; this one is about the
  // water having a top end you can actually hook, and two animals that are simply enormous.

  // Shortfin mako — the fastest shark in the ocean and a serious gamefish, so unlike the others
  // here it IS catchable. Deep metallic blue over a white belly, a hard lunate tail like a tuna's
  // rather than the heterocercal shark fin: makos are built like a billfish and it shows.
  mako:{kind:'shark',len:3.6,h:.58,w:.56,back:'#1f4f86',belly:'#f2f5f8',fin:'#1b4472',level:'mid',speed:3.4,school:[1,1],spread:0,dMin:20,dMax:1e5},
  // Great white — prohibited in Florida, so not catchable, and weighted so low you may never see
  // one. Which is the point: it should be a thing you tell people about.
  greatwhite:{kind:'shark',len:5,h:1.05,w:1,back:'#6a7078',belly:'#f4f4f2',fin:'#565c63',level:'mid',speed:1.6,school:[1,1],spread:0,dMin:12,dMax:1e5,catchable:false},
  // Sperm whale — the Gulf of Mexico has a genuine resident population, and they are deep-water
  // animals, so this belongs out past the wall and over the Humps rather than inshore. `blunt`
  // plus a heavy `hump` is that enormous square forehead, which is most of the animal.
  //
  // It lives ONLY in the Humps table (weight 0.3), deliberately not in Offshore. The Humps make a
  // rare thing PLACE-BASED and learnable (see the pilot whale's note): a hump resident is anchored,
  // so this whale is findable if you know where to go, where a roamer scattered across 27 km2 of
  // open water would be luck. At 0.1 it had no presence at all within 15 km of five offshore
  // origins, hence the floor. Census (test/ocean-census.test.ts) at 0.3: 2 schools in the whole
  // 68.9 km2 box, one encounter per ~187 km of straight track (was 41 km at 0.45 + Offshore 0.05).
  // Search area is two 0.2 km2 humps, so a hump-anchored 2 is a pair of places to learn, not a coin flip.
  spermwhale:{kind:'whale',len:14,h:2.3,w:2.1,back:'#4a4542',belly:'#6b6460',pattern:'mottle',blunt:true,level:'surface',speed:1.6,school:[1,3],spread:12,dMin:35,dMax:1e5,act:'blow',catchable:false},
  // Ocean sunfish — a 3 m disc with no tail to speak of, drifting on its side at the surface.
  // Nothing else in the water looks remotely like it, which is the whole reason to have one.
  //
  // Offshore only (weight 0.03): it is a pelagic drifter, not a structure-holder, and the Humps /
  // DeepWall entries it used to carry were a workaround for an earlier "I searched 12 km and found
  // none" that the roaming layer has since fixed. Census: 6 schools in the box, one encounter per
  // ~52 km of track (was 18 km at 0.14 + the structure entries). Still an event; no longer a chore.
  mola:{kind:'fish',len:3,h:2.6,w:.55,back:'#8d939a',belly:'#d8dce0',pattern:'mottle',level:'surface',speed:.5,school:[1,1],spread:0,dMin:18,dMax:1e5,act:'roll',catchable:false},
  // Warsaw grouper — the deep-drop monster. Same body plan as the goliath, darker, and it lives
  // where you need the bottle to reach it.
  warsaw:{kind:'fish',len:2.3,h:.72,w:.5,back:'#3b332e',belly:'#6d625a',fin:'#2c2521',level:'bottom',speed:.45,school:[1,1],spread:0,dMin:25,dMax:1e5},
  // Cubera snapper — the biggest snapper there is, and a wreck fish. Dark, slab-sided, with the
  // heavy jaw the species is known for.
  cubera:{kind:'fish',len:1.6,h:.52,w:.28,back:'#5a4a46',belly:'#b9a89c',fin:'#3e3330',level:'bottom',speed:.8,school:[1,3],spread:3,dMin:8,dMax:60},

  /**
   * THE GOLD BLUEFIN. Three giants, over a thousand pounds each, and there is exactly one school
   * of them in the entire world.
   *
   * It appears in NO zone table on purpose. Every other creature here is placed by the
   * resident/near-field/roamer layers from `ZONE_LIFE`, which means "how often do you meet one"
   * is a weight. These are placed by hand, once, and then wander the whole chart forever
   * (entities/fish/index.ts's legend school) — so meeting them is not a dice roll per chunk, it
   * is a question of where they happen to be when you happen to be there. You go looking, or
   * they come past you.
   *
   * Over a thousand pounds each at this length — a real giant bluefin runs 3 m and 1,000-1,500 lb,
   * and these are drawn at 3.1 m.
   *
   * `catchable: false`, and with no `SPECIES` entry at all. That is not a shortcut: a SPECIES
   * entry IS the rod-fishing weight/strength table, and test/catchable.test.ts holds the line
   * that nothing in it may be uncatchable. So they are a sighting, like the whale shark and the
   * giant manta — there is no rod roll and no spear hit, and no weight is ever displayed because
   * nothing ever weighs one. Making them hookable is a real piece of work rather than a flag:
   * a cast table that only offers them when you are actually among them, and a fight tuned an
   * order of magnitude above anything else in the game.
   */
  goldbluefin:{kind:'tuna',tuna:true,len:3.1,h:.84,w:.66,back:'#8a6a1c',belly:'#f6e7a8',fin:'#b8902c',finlet:'#ffd84a',sickle:.46,pattern:'spots',level:'surface',speed:3.4,school:[3,3],spread:5,dMin:6,dMax:1e5,act:'bust',catchable:false},
};

/** Single source of truth for "can this creature ever be landed" — see `CreatureVis.catchable`'s
 * doc comment. Consulted by both catch paths (`sim/fight.ts`'s `pickSpecies`, `sim/spear.ts`'s
 * `capsuleFromSpecies`) so a species only needs its flag set once, here, to be excluded from
 * every way of catching it. */
export function isCatchable(key: string): boolean {
  return VIS[key]?.catchable !== false;
}

/**
 * Per-habitat ambient-life tables, keyed primarily by `Zone` (@keysrun/shared/world/depth) but
 * with three extra keys — `ReefWall`, `DeepWall` and `Humps` — that are *not* zone names. `zoneAt`
 * only ever returns the seven `Zone` strings; `ReefWall`/`DeepWall`/`Humps` are a finer habitat
 * split that apps/client/src/entities/fish/spawn.ts layers on top of `zoneAt` using depth (the
 * reef crest vs. the wall top/ledges vs. the deep wall, over the 3.4->45.4 m drop) and proximity
 * to a named `HUMPS` structure, so this table can tell "shallow patch reef" apart from "wall top/
 * ledge" apart from "deep wall/wreck" apart from "real offshore structure" apart from "open water"
 * without changing `zoneAt`'s return type or touching `packages/shared/src/world` at all. See
 * docs/ARCHITECTURE.md's depth-band table (five bands: 0-5/5-10/10-15/15-20/20+ m) and "The Humps"
 * in the task brief.
 */
export const ZONE_LIFE: Record<string, Array<[string, number]>> = {
  // Mangrove creek channels — juveniles sheltering along the edges. Creek is 0.1 km2 (14 schools in
  // the census), so every weight here is a coin flip at the sweep scale: flounder, sole and manatee
  // fit the 2.6-9 m channel depth and stay (a hogchoker and a manatee are exactly what a creek is
  // for), but the census may show them at 0. Sawfish was removed from this table — at its rarity it
  // had a ~0.01 expected placement here; Backcountry and Flats carry it.
  'Creek':[['flounder',2],['sole',1.6],['snook',3],['redfish',2.5],['tarpon',1.5],['manatee',1],['mangrove',3.5],['ladyfish',2.5],['trout',1.5],['jackcrevalle',1]],
  // Very shallow skinny water — bonefish/permit on the sand, small sharks cruising the edges.
  'Flats':[['flounder',2.5],['sole',1.2],['sawfish',.012],['bonefish',5],['permit',2.2],['stingray',3],['redfish',1.5],['barracuda',2],['blacktip',1.5],['lemonshark',1],['eagleray',1],['ladyfish',3],['pompano',1.2],['palometa',3],['bluerunner',2],['manatee',.7]],
  // Florida Bay backcountry — juvenile snapper, small barracuda, rays on the sand, baitfish
  // schools, manatees in the shallows, and dolphin pods working the bay ("the bay" in the task
  // brief).
  'Backcountry':[['flounder',2.5],['sole',1.8],['sawfish',.01],['redfish',4],['snook',3],['trout',3],['mangrove',2.5],['tarpon',2],['bonefish',1.5],['permit',1],['barracuda',1.2],['manatee',1.2],['stingray',2.2],['jackcrevalle',2],['ladyfish',3],['pompano',1.5],['tripletail',.6],['dolphin',1.5]],
  // Bridge pilings and the channels that run under them — structure-holders in current. Dolphin
  // pods regularly work the bridge channels for bait pushed through on the tide.
  'Bridge':[['flounder',1.5],['tarpon',5],['snook',2],['mangrove',3],['eagleray',1],['sheepshead',3],['goliath',.6],['jackcrevalle',1.5],['nurse',1],['cobia',1],['barracuda',1],['dolphin',1.2],['lookdown',3.5],['bluerunner',4],['schoolmaster',2],['manatee',.9]],
  // (Halibut was listed here at 0.35 but declares 18-240 m and this zone is 2.6-9.4 m deep; the
  // entry could never place, so it is gone. Offshore carries it.)
  // Mixed mid-water schools, mackerel and jacks between the Bay and the reef line — classic
  // bottlenose water, hence the higher dolphin weight ("less rare" per the task brief).
  'Hawk Channel':[['mangrove',4],['eagleray',2],['turtle',1.5],['barracuda',2],['nurse',1.5],['mutton',2],['dolphin',1.8],['cero',2],['pompano',1.5],['cobia',1],['graytrigger',1.2],['jackcrevalle',1.8],['yellowtail',1.5],['sheepshead',1.2],['tarpon',1.6],['goliath',.5],['bullshark',.35],['bluerunner',4.5],['lanesnapper',3],['spanishmack',3],['lookdown',1.5],['schoolmaster',2]],
  // Patch reef / Sombrero crest — the existing shallow reef life (depthAt < REEF_WALL_DEPTH).
  // Dolphins work the reef line hunting bait off the coral too.
  'Reef':[['cubera',.5],['yellowtail',5],['parrotfish',3],['angelfish',2],['hogfish',2],['grouper',2],['gag',1.2],['redgrouper',1.2],['nurse',1],['turtle',1.5],['barracuda',1.5],['mutton',2],['lionfish',1.5],['graytrigger',2],['cero',2],['goliath',1.1],['hammerhead',.3],['bullshark',.3],['tarpon',1.2],['dolphin',1],['schoolmaster',4.5],['lanesnapper',3.5],['bluerunner',4],['vermilion',2],['spanishmack',2]],
  // The reef wall's top and ledges (depthAt in [REEF_WALL_DEPTH, DEEP_WALL_DEPTH), spawn.ts).
  // Only species whose depth band overlaps 12-20 m are listed: mako (dMin 20), warsaw (dMin 25)
  // and the whale shark / giant manta (expected placements << 1 at their rarity) were here and
  // never placed; DeepWall and Offshore carry them.
  // docs/ARCHITECTURE.md bands 3-4 (reef wall top / elkhorn-staghorn, ledges and overhangs):
  // grouper holding on ledges, bigger snapper/jack schools working the drop, dolphins cruising
  // the wall edge. `DeepWall` below (band 5, >= DEEP_WALL_DEPTH) used to be the same table all the
  // way to 45 m — split out so the deep wall/wreck band actually feels different, not just emptier.
  'ReefWall':[['cubera',.7],['tigershark',.12],['grouper',3],['gag',2],['redgrouper',2],['yellowtail',4],['mutton',2.5],['amberjack',2],['kingfish',1.5],['cero',1.5],['nurse',1],['goliath',.6],['graytrigger',1.2],['lionfish',1],['hammerhead',.8],['bullshark',.5],['cobia',1],['dolphin',1.3],['vermilion',5],['bluerunner',3],['schoolmaster',2]],
  // The deep wall and wrecks (depthAt >= DEEP_WALL_DEPTH, spawn.ts) — docs/ARCHITECTURE.md band 5
  // (20 m+, "deep wall, wrecks, the Humps... torch required, blackout risk"). Bigger-bodied
  // structure-holders and more apex presence than the wall top, less of the small schooling
  // yellowtail/mutton clutter that reads as "shallow reef" — this is what makes the deep band feel
  // like a different place rather than the same reef with the lights turned down.
  'DeepWall':[['warsaw',1],['cubera',.6],['mako',.3],['giantmanta',.04],['tigershark',.2],['grouper',3.5],['gag',2.5],['redgrouper',2],['amberjack',3],['kingfish',2],['cobia',1.5],['goliath',1.3],['nurse',1.5],['hammerhead',.7],['bullshark',.5],['mutton',1.4],['yellowtail',1],['cero',1],['dolphin',1],['vermilion',3.5],['bluerunner',1.5]],
  // Gulf Stream / open offshore — pelagics (roaming layer only; see spawn.ts). Dolphin pods are a
  // common sight riding the current lines; pilot whales/humpbacks are a genuine *rare* event out
  // here — tiny weights are deliberate (see the task brief's "Encounter rarity").
  'Offshore':[['halibut',1.1],['mako',.5],['mola',.03],['greatwhite',.025],['whaleshark',.04],['giantmanta',.04],['tigershark',.14],['mahi',5],['flyingfish',4],['dolphin',2.5],['blackfin',3],['sailfish',1.5],['wahoo',1],['turtle',.8],['marlin',.6],['blackmarlin',.25],['swordfish',.3],['yellowfin',2.5],['albacore',1.2],['bluefin',.8],['kingfish',1.5],['amberjack',1.5],['hammerhead',.3],['pilotwhale',.12],['humpback',.02],['skipjack',4],['bigeye',.7]],
  // The Humps are 40 m at the crest and 123 m at the 260 m radius (depthAt: 40 + 0.32 x distance),
  // so only species that can live deeper than 40 m belong. Barracuda (dMax 20), yellowtail (40),
  // nurse (30), goliath, bullshark (40) and mutton (40) are shallow-structure fish whose entries
  // never placed a school and quietly wasted the chunk; humpback is a migrant, not hump-bound, and
  // lives in Offshore. Gag and red grouper stay: adults of both are deep-ledge fish (50-100+ m), so
  // their declared band (dMax 60, 0 placed) was the bug and is widened to 120. Grouper (9.8% of this
  // table, 0 placed) and blue runner (11.8% nominal, 1.1% observed) had the same dMax 60 and get
  // the same fix: both are common over deep structure.
  // The Humps (Marathon Hump, West Hump) and other named structure far offshore — real relief that
  // concentrates bottom fish and jacks well out in otherwise-open water. Marathon's actual humps
  // are a known pilot-whale spot — a tiny weight here makes that a learnable, place-based rarity
  // (docs/ARCHITECTURE.md's resident-school note) rather than a per-frame dice roll.
  'Humps':[['spermwhale',.3],['warsaw',1.2],['mako',.35],['amberjack',4],['grouper',2.5],['gag',1.5],['redgrouper',1.5],['cobia',2],['kingfish',1.5],['pilotwhale',2.6],['vermilion',3],['bluerunner',3],['skipjack',2]]
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
  flounder:{peak:.46,nose:.35,ped:.13,tail:'round',tl:.15,th:.5,dor:[[.1,.93,.3,'long']],anal:[[.36,.93,.26,'long']],pec:.1,belly:.95},
  sheepshead:{peak:.4,nose:.55,ped:.22,tail:'fork',tl:.18,th:.5,dor:[[.25,.78,.3,'spiny']],anal:[[.6,.78,.3,'round']],pec:.16,hump:.12},
  pompano:{peak:.42,nose:.4,ped:.1,tail:'fork',tl:.32,th:.85,dor:[[.48,.72,.35,'sickle']],anal:[[.5,.72,.35,'sickle']],pec:.14},
  tripletail:{peak:.42,nose:.6,ped:.3,tail:'round',tl:.16,th:.55,dor:[[.3,.78,.35,'round']],anal:[[.55,.8,.38,'round']],pec:.14},
  lionfish:{peak:.38,nose:.6,ped:.25,tail:'round',tl:.2,th:.6,dor:[[.2,.6,1.4,'spiny'],[.62,.8,.6,'round']],anal:[[.62,.8,.5,'round']],pec:.75,wings:true},
  goliath:{peak:.42,nose:.55,ped:.32,tail:'round',tl:.16,th:.45,dor:[[.3,.8,.22,'spiny']],anal:[[.65,.82,.25,'round']],pec:.18,belly:1.08},
  graytrigger:{peak:.42,nose:.55,ped:.2,tail:'lyre',tl:.2,th:.55,dor:[[.25,.33,.5,'tri'],[.48,.78,.35,'sickle']],anal:[[.5,.78,.35,'sickle']],pec:.12},
  bullshark:{peak:.36,nose:.8,ped:.12,tail:'hetero',tl:.26,th:1,dor:[[.32,.44,.8,'sickle'],[.7,.75,.25,'tri']],anal:[[.72,.77,.2,'tri']],pec:.5,shark:true},
  lemonshark:{peak:.38,nose:1,ped:.12,tail:'hetero',tl:.26,th:1,dor:[[.36,.47,.6,'sickle'],[.6,.7,.55,'sickle']],anal:[[.68,.74,.25,'tri']],pec:.5,shark:true},
  hammerhead:{peak:.38,nose:1.2,ped:.1,tail:'hetero',tl:.3,th:1.1,dor:[[.3,.42,1.5,'sickle'],[.72,.76,.3,'tri']],anal:[[.72,.77,.3,'tri']],pec:.4,shark:true},
  // --- FWC chart species (see the VIS block above) -----------------------------------------
  // Jack body plan: deep-ish, strongly forked tail on a thin peduncle, sickle second dorsal/anal.
  bluerunner:{peak:.38,nose:.7,ped:.1,tail:'fork',tl:.3,th:.8,dor:[[.34,.74,.28,'sickle']],anal:[[.56,.74,.26,'sickle']],pec:.18},
  // Snapper body plan (as mangrove): continuous spiny dorsal, rounded anal, slight fork.
  schoolmaster:{peak:.38,nose:.8,ped:.2,tail:'truncate',tl:.2,th:.55,dor:[[.3,.74,.32,'spiny']],anal:[[.64,.77,.3,'round']],pec:.15},
  lanesnapper:{peak:.38,nose:.8,ped:.18,tail:'fork',tl:.24,th:.6,dor:[[.3,.74,.3,'spiny']],anal:[[.64,.77,.28,'round']],pec:.15},
  // Slimmer, more forked than the Lutjanus snappers above — vermilion is built for midwater.
  vermilion:{peak:.36,nose:.85,ped:.16,tail:'fork',tl:.3,th:.75,dor:[[.3,.75,.28,'spiny']],anal:[[.64,.78,.24,'tri']],pec:.16},
  // Lookdown: the steep near-vertical forehead is the whole silhouette, so `nose` is pushed well
  // below 0.5 (a low exponent makes the profile rise almost immediately off the snout) and the
  // body peak sits far forward. Trailing dorsal/anal filaments complete it.
  lookdown:{peak:.26,nose:.32,ped:.1,tail:'fork',tl:.3,th:.78,dor:[[.3,.84,.5,'trail']],anal:[[.42,.84,.42,'trail']],pec:.16},
  // Palometa: pompano shape with much longer trailing dorsal/anal lobes.
  palometa:{peak:.42,nose:.4,ped:.1,tail:'fork',tl:.32,th:.9,dor:[[.44,.72,.78,'trail']],anal:[[.48,.74,.7,'trail']],pec:.14},
  // Spanish mackerel: same mackerel plan as cero, slightly deeper body, finlet row to the tail.
  spanishmack:{peak:.4,nose:1.3,ped:.12,tail:'lunate',tl:.2,th:1.1,dor:[[.2,.4,.25,'spiny'],[.48,.58,.3,'tri']],anal:[[.56,.64,.3,'tri']],pec:.1,finlets:true},
  // --- tuna chart species ------------------------------------------------------------------
  // Bigeye: the deepest-bodied of the three mid-size tunas, lunate tail, full finlet row.
  bigeye:{peak:.42,nose:.85,ped:.06,tail:'lunate',tl:.25,th:1.2,dor:[[.3,.4,.44,'tri']],anal:[],pec:.22,finlets:true},
  // Skipjack: the slimmest, most torpedo-like tuna here.
  skipjack:{peak:.44,nose:.9,ped:.06,tail:'lunate',tl:.24,th:1.15,dor:[[.3,.4,.36,'tri']],anal:[],pec:.18,finlets:true},
  dolphin:{peak:.38,nose:.7,ped:.14,tail:'flukes',tl:.2,th:1,dor:[[.42,.55,.7,'sickle']],anal:[],pec:.2,hump:.18},
  // Short-finned pilot whale — bulbous melon forehead (strong `hump`), low hooked dorsal set
  // forward of mid-body (real pilot whales, unlike a dolphin's tall mid-back sickle), flukes.
  pilotwhale:{peak:.3,nose:.5,ped:.16,tail:'flukes',tl:.22,th:1.1,dor:[[.28,.4,.4,'sickle']],anal:[],pec:.16,hump:.5},
  // Humpback — the signature huge pectoral "wings" (`pec:.34,wings:true` — up to ~1/3 body length
  // on the real animal), a tiny stubby rounded dorsal far aft, flukes, a slightly knobbly head.
  humpback:{peak:.3,nose:.6,ped:.2,tail:'flukes',tl:.26,th:1.15,dor:[[.56,.63,.15,'round']],anal:[],pec:.34,wings:true,hump:.18},
  // The big ones (see their VIS entries above for why each is here).
  // Whale shark: a blunt, boxy head on a huge body — nothing about it is streamlined. The broad
  // flat snout is `nose:.35`, and the tail is the tall heterocercal shark fin every shark uses.
  whaleshark:{peak:.22,nose:.35,ped:.16,tail:'hetero',tl:.26,th:1.15,dor:[[.42,.56,.6,'tri'],[.72,.79,.25,'tri']],anal:[[.74,.8,.22,'tri']],pec:.5,shark:true,belly:.8},
  // Giant manta: the body is almost all wing, so the fins carry none of it (kind 'ray' builds the
  // disc from `wing`); what is left is a thin, flat body and a whip tail.
  giantmanta:{peak:.3,nose:.3,ped:.05,tail:'whip',tl:.9,th:.08,dor:[],anal:[],pec:.1},
  // Sawfish: shark-bodied behind the rostrum, with the dorsals set well back the way a sawfish's
  // are — nearly over the tail, which is one of the things that distinguishes it from a sawshark.
  sawfish:{peak:.34,nose:.9,ped:.14,tail:'hetero',tl:.26,th:.85,dor:[[.56,.68,.6,'tri'],[.74,.82,.45,'tri']],anal:[[.76,.83,.2,'tri']],pec:.34,shark:true},
  // Tiger shark: a heavy forward body tapering hard to the tail, blunt square snout, the tall
  // upper lobe exaggerated a little because it is the silhouette people know.
  tigershark:{peak:.3,nose:.75,ped:.12,tail:'hetero',tl:.3,th:1.2,dor:[[.32,.44,1.1,'tri'],[.74,.8,.3,'tri']],anal:[[.74,.8,.3,'tri']],pec:.42,shark:true},
  // The second batch (see their VIS entries above).
  // Mako: a tuna's body on a shark — pointed snout, hard keel, a near-symmetrical lunate tail.
  mako:{peak:.34,nose:1.1,ped:.08,tail:'lunate',tl:.24,th:1.25,dor:[[.33,.44,.95,'tri'],[.74,.79,.22,'tri']],anal:[[.74,.79,.22,'tri']],pec:.36,shark:true},
  // Great white: a conical snout on a very deep forward body that tapers hard to a thin tail —
  // the silhouette everyone already knows, so it has to be right.
  greatwhite:{peak:.3,nose:.8,ped:.1,tail:'hetero',tl:.28,th:1.3,dor:[[.33,.45,1.25,'tri'],[.76,.81,.28,'tri']],anal:[[.75,.8,.28,'tri']],pec:.46,shark:true},
  // Sperm whale: the forehead is a third of the body and square at the front, the jaw is a thin
  // rod underneath it, the dorsal is a knuckle rather than a fin, and the flukes are huge.
  spermwhale:{peak:.18,nose:.3,ped:.2,tail:'flukes',tl:.24,th:1.3,dor:[[.62,.7,.12,'round']],anal:[],pec:.12,hump:.62},
  // Mola: almost all body. The dorsal and anal fins are enormous and opposite each other, and the
  // "tail" is the clavus — a stiff rudder, hence `truncate` with almost no length.
  mola:{peak:.45,nose:.4,ped:.62,tail:'truncate',tl:.06,th:1.4,dor:[[.3,.52,1.5,'tri']],anal:[[.3,.52,1.5,'tri']],pec:.1},
  // Warsaw: the goliath's plan, deeper in the body and blunter — a fish shaped like a boulder.
  warsaw:{peak:.4,nose:.5,ped:.34,tail:'round',tl:.15,th:.5,dor:[[.26,.8,.26,'spiny']],anal:[[.64,.82,.26,'round']],pec:.2,belly:1.1},
  // Cubera: a snapper's profile with the jaw carried heavy and forward.
  cubera:{peak:.38,nose:.8,ped:.22,tail:'truncate',tl:.2,th:.62,dor:[[.3,.76,.3,'spiny']],anal:[[.64,.78,.3,'round']],pec:.17,belly:1.02},
  // Same hull as a bluefin — it IS a bluefin — a little deeper through the shoulder, which is
  // what a fish that size actually looks like.
  goldbluefin:{peak:.43,nose:.88,ped:.06,tail:'lunate',tl:.23,th:1.1,dor:[[.3,.4,.42,'tri']],anal:[],pec:.15,finlets:true},
};
