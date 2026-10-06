/**
 * Boats and hulls: the 5 playable center consoles and their hull/buoyancy parameters.
 *
 * Ported faithfully from legacy/index.html lines 539-574 (BOATS, HULLS, SPEED_SCALE) and 2964
 * (COOLER_CAP). This is plain data; the 15-point buoyancy integrator that reads HullSpec stays
 * client/sim-side for a later phase. Every value preserved exactly.
 */

export interface HullColors {
  bottom: number;
  boot: number;
  hull: number;
  cove: number | null;
  rub: number;
  cap: number;
  liner: number;
  deck: number;
}

export interface HullStyle {
  top: string;
  frame: number;
  topc: number;
  seat: string;
  bowRail: boolean;
  outriggers: boolean;
  mount: string;
  uph: number;
  eng: number;
  engAcc: number;
  engLow: number;
  radar?: boolean;
  rodRack?: boolean;
  underLights?: boolean;
  wideTop?: boolean;
  enclosed?: boolean;
  dome?: boolean;
  bowLounge?: boolean;
  quilt?: boolean;
  bigTower?: boolean;
  sunpad?: boolean;
}

export interface HullSpec {
  F: number;
  spring: number;
  yk: number;
  dr0: number;
  dr1: number;
  rake: number;
  entry: number;
  steps: number[];
  colors: HullColors;
  style: HullStyle;
  cat?: boolean;
  tunnel?: number;
}

export const HULLS: Record<string, HullSpec> = {
  robalo:{F:1.05,spring:.38,yk:.45,dr0:20,dr1:48,rake:.9,entry:.42,steps:[],
    colors:{bottom:0xf4f4f2,boot:0x6fa8c9,hull:0xffffff,cove:null,rub:0x8e949a,cap:0xffffff,liner:0xf1f1ee,deck:0xdcddd8},
    style:{top:'hardtop',frame:0xf2f2f2,topc:0xf4f4f2,seat:'leaning',bowRail:true,outriggers:false,mount:'transom',uph:0x6fa8c9,eng:0xf4f4f2,engAcc:0x6fa8c9,engLow:0x2a2d31}},
  grady:{F:1.3,spring:.52,yk:.55,dr0:20,dr1:50,rake:1.3,entry:.4,steps:[],
    colors:{bottom:0xf8f7f2,boot:0x23466e,hull:0xfbfaf6,cove:0x23466e,rub:0xd0d4d8,cap:0xfbfaf6,liner:0xf3f2ec,deck:0xe0ded6},
    style:{top:'ttop',frame:0xc9ced3,topc:0x23466e,seat:'leaning',bowRail:true,outriggers:true,radar:true,mount:'transom',uph:0xe8e4d8,eng:0xf4f4f2,engAcc:0x23466e,engLow:0x2a2d31}},
  freeman:{cat:true,F:1.45,spring:.3,yk:.55,tunnel:.42,dr0:22,dr1:50,rake:1.1,entry:.5,steps:[.36],
    colors:{bottom:0xf2f2f0,boot:0x74bfe6,hull:0xf4f6f7,cove:null,rub:0x2a2d31,cap:0xf7f7f5,liner:0xf3f2ee,deck:0xe6e2d8},
    style:{top:'hardtop',frame:0x15171a,topc:0xf7f7f5,seat:'helm',bowRail:false,outriggers:true,radar:true,mount:'bracket',uph:0x9aa0a6,rodRack:true,underLights:true,eng:0xf4f4f2,engAcc:0xb9bec4,engLow:0xe2e5e8,wideTop:true,enclosed:true,dome:true,bowLounge:true,quilt:true,bigTower:true}},
  midnight:{F:1.4,spring:.35,yk:.62,dr0:22,dr1:54,rake:2.1,entry:.46,steps:[.3,.44],
    colors:{bottom:0x2a2d31,boot:0xc8a24a,hull:0x17191d,cove:0xc8a24a,rub:0x0d0e10,cap:0xf4f4f2,liner:0xf4f4f2,deck:0xe7e5df},
    style:{top:'hardtop',frame:0x17191d,topc:0xf4f4f2,seat:'helm',bowRail:false,outriggers:false,mount:'bracket',sunpad:true,uph:0xf3efe6,eng:0x17191d,engAcc:0xc8a24a,engLow:0x17191d}},
  mti:{F:1.35,spring:.3,yk:.6,dr0:24,dr1:55,rake:2.3,entry:.48,steps:[.28,.42],
    colors:{bottom:0x15171a,boot:0xf4f4f4,hull:0xc8102e,cove:0xf4f4f4,rub:0x0d0e10,cap:0xf4f4f4,liner:0xf4f4f4,deck:0x2a2d31},
    style:{top:'hardtop',frame:0x15171a,topc:0x15171a,seat:'helm',bowRail:false,outriggers:false,mount:'bracket',sunpad:true,uph:0x1d1f23,eng:0xc8102e,engAcc:0xf4f4f4,engLow:0x15171a}}
};

export interface BoatStats {
  Speed: number;
  Handling: number;
  'Skinny water': number;
  'Rough water': number;
}

export interface BoatBase {
  id: string;
  brand: string;
  name: string;
  nickname?: string;
  power: string;
  len: number;
  beam: number;
  engines: number;
  top: number;
  accel: number;
  turn: number;
  draftFt: string;
  draft: number;
  cat?: boolean;
  hull: number;
  hullCss: string;
  stripe: number;
  canvas: number;
  engine: number;
  hardtop?: boolean;
  stats: BoatStats;
  desc: string;
}

export interface Boat extends BoatBase {
  hp: HullSpec;
}

const BOATS_BASE: BoatBase[] = [
  {id:'robalo',brand:'Robalo',name:'R230',power:'Single Mercury Racing 450R',len:7.0,beam:2.59,engines:1,top:52,accel:.62,turn:1.15,draftFt:'1\' 7"',draft:.6,
   hull:0xffffff,hullCss:'#ffffff',stripe:0x6fa8c9,canvas:0xf4f4f2,engine:0xd8dadc,hardtop:true,
   stats:{Speed:.57,Handling:.95,'Skinny water':.95,'Rough water':.35},desc:'A nimble 23-footer that slips onto the flats and under the bridges. Gets wet and bouncy once you pass the reef.'},
  {id:'grady',brand:'Grady-White',name:'Canyon 306',nickname:'Actively Sinking',power:'Twin Mercury Racing 450R',len:9.3,beam:3.23,engines:2,top:58,accel:.5,turn:.9,draftFt:'1\' 9"',draft:.72,
   hull:0xfbfaf6,hullCss:'#fbfaf6',stripe:0x23466e,canvas:0x23466e,engine:0xd8dadc,
   stats:{Speed:.62,Handling:.8,'Skinny water':.75,'Rough water':.7},desc:'The classic all-rounder. Its deep-V hull smooths out Hawk Channel chop and runs to blue water with confidence.'},
  {id:'freeman',brand:'Freeman',name:'42LR',power:'Quad Mercury Racing 450R',len:12.8,beam:3.58,engines:4,top:69,accel:.44,turn:.72,draftFt:'2\' 0"',draft:.82,cat:true,
   hull:0xf4f6f7,hullCss:'#f4f6f7',stripe:0x1f2a33,canvas:0xf2f2ee,engine:0xf4f4f2,hardtop:true,
   stats:{Speed:.81,Handling:.62,'Skinny water':.7,'Rough water':1},desc:'A long-range catamaran built for tournament fishing. Twin hulls ride flat and soft offshore, and it drafts shallow for its size.'},
  {id:'midnight',brand:'Midnight Express',name:'43 Open',power:'Quad Mercury Racing 450R',len:13.1,beam:3.81,engines:4,top:70,accel:.42,turn:.66,draftFt:'2\' 0"',draft:.9,
   hull:0x1c1f24,hullCss:'#1c1f24',stripe:0xc8a24a,canvas:0xf2f2ee,engine:0x1c1f24,hardtop:true,
   stats:{Speed:.88,Handling:.58,'Skinny water':.6,'Rough water':.92},desc:'A twin-step deep-V luxury rocket with a very wide beam. Fast, stable, and dry, but keep it in real water.'},
  {id:'mti',brand:'MTI',name:'V42',power:'Quad Mercury Racing 450R',len:12.8,beam:3.5,engines:4,top:76,accel:.46,turn:.62,draftFt:'3\' 0"',draft:1.15,
   hull:0xc8102e,hullCss:'#c8102e',stripe:0xf4f4f4,canvas:0x15171a,engine:0x15171a,hardtop:true,
   stats:{Speed:1,Handling:.55,'Skinny water':.4,'Rough water':.85},desc:'The fastest center console here, with race-bred power. It covers the Keys in minutes, but its deeper draft keeps it off the flats.'}
];

/** BOATS with each boat's hull/buoyancy spec attached (legacy index.html:573). */
export const BOATS: Boat[] = BOATS_BASE.map((b) => ({ ...b, hp: HULLS[b.id] }));

export const SPEED_SCALE: number = 1.35;

export const COOLER_CAP: Record<string, number> = {robalo:150,grady:350,freeman:800,midnight:400,mti:300};
