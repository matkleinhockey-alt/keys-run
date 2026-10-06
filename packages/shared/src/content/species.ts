/**
 * Species biology and the per-zone species tables.
 *
 * Ported faithfully from legacy/index.html lines 484-536 (SPECIES, ZONE_TABLE) and 2662-2663
 * (SOUNDERS, BILLFISH). Plain data — no three.js, no DOM. Every value preserved exactly.
 */

export interface SpeciesDef {
  name: string;
  min: number;
  max: number;
  str: number;
  mult: number;
  color: string;
  fact: string;
  jump?: boolean;
}

export const SPECIES: Record<string, SpeciesDef> = {
  bonefish:{name:'Bonefish',min:3,max:12,str:.65,mult:30,color:'#d2dade',fact:'The gray ghost of the flats. In Florida, bonefish are catch-and-release only.'},
  permit:{name:'Permit',min:8,max:40,str:.85,mult:28,color:'#b6c3ca',fact:'Famously picky crab-eaters. Landing one is a career moment for flats anglers.'},
  tarpon:{name:'Tarpon',min:30,max:160,str:1.05,mult:10,color:'#dfe8ee',jump:true,fact:'The silver king. Florida tarpon are catch-and-release unless you hold a harvest tag.'},
  barracuda:{name:'Great Barracuda',min:5,max:45,str:.7,mult:6,color:'#9db2bf',jump:true,fact:'An ambush predator that can’t resist a fast, flashy tube lure.'},
  snook:{name:'Snook',min:4,max:30,str:.6,mult:12,color:'#cfc6a0',fact:'Snook hug mangrove edges and bridge shadows, waiting for the tide to bring bait.'},
  redfish:{name:'Redfish',min:4,max:28,str:.55,mult:10,color:'#cf8c4e',fact:'Look for copper tails waving above the surface in skinny water.'},
  trout:{name:'Spotted Seatrout',min:1,max:8,str:.3,mult:12,color:'#b1ae8f',fact:'Big trout cruise the grass flats at first light.'},
  mangrove:{name:'Mangrove Snapper',min:1,max:12,str:.35,mult:14,color:'#a85a4b',fact:'Smart and leader-shy. Go lighter and you’ll get more bites.'},
  yellowtail:{name:'Yellowtail Snapper',min:1,max:7,str:.3,mult:16,color:'#e8c547',fact:'Chum them up behind the boat along the reef edge.'},
  mutton:{name:'Mutton Snapper',min:4,max:22,str:.5,mult:12,color:'#d97b69',fact:'A prized reef snapper that eats best on a bottom-fished bait.'},
  hogfish:{name:'Hogfish',min:2,max:20,str:.4,mult:15,color:'#eaa07c',fact:'Usually speared, but a live shrimp on the bottom will tempt one.'},
  grouper:{name:'Black Grouper',min:10,max:80,str:.95,mult:8,color:'#5f5c53',fact:'Lock the drag and pull hard — they bolt for the rocks.'},
  mahi:{name:'Mahi-Mahi',min:6,max:55,str:.8,mult:9,color:'#7cd34c',jump:true,fact:'Find floating weedlines with birds working, and the mahi are underneath.'},
  blackfin:{name:'Blackfin Tuna',min:6,max:40,str:.85,mult:9,color:'#2c4268',fact:'Blackfin school around the offshore humps beyond the reef.'},
  wahoo:{name:'Wahoo',min:15,max:90,str:1,mult:8,color:'#4d80a9',fact:'Razor teeth and blistering first runs — wire leader recommended.'},
  sailfish:{name:'Sailfish',min:30,max:100,str:1.1,mult:12,color:'#3155a6',jump:true,fact:'A Keys winter favorite, usually caught with kites and live bait.'},
  yellowfin:{name:'Yellowfin Tuna',min:20,max:220,str:1.15,mult:8,color:'#e9c43a',fact:'Named for the long golden second dorsal and anal fins of big adults. Yellowfin often travel with pods of dolphins.'},
  bluefin:{name:'Atlantic Bluefin Tuna',min:150,max:900,str:1.55,mult:5,color:'#14224a',fact:'Warm-blooded giants. In spring some pass through the Florida Straits on their way to spawn in the Gulf of Mexico.'},
  albacore:{name:'Albacore',min:15,max:60,str:.85,mult:10,color:'#7f93b8',fact:'The longfin tuna — those huge pectoral fins give it away. A rare visitor this far south.'},
  cobia:{name:'Cobia',min:10,max:90,str:1,mult:9,color:'#3b3328',fact:'Cobia shadow rays, turtles and sharks — sight-cast when one cruises by.'},
  amberjack:{name:'Greater Amberjack',min:15,max:120,str:1.15,mult:7,color:'#8a7b45',fact:'Amberjack crowd the Marathon Hump and wrecks, then bulldog straight for the bottom.'},
  kingfish:{name:'King Mackerel',min:8,max:60,str:.9,mult:9,color:'#3d5a7a',fact:'Kingfish run the reef edge in winter; slow-trolled live baits draw the big "smokers".'},
  cero:{name:'Cero Mackerel',min:2,max:12,str:.5,mult:14,color:'#3f6286',fact:'Cero hang over the reef — the Keys’ own gold-spotted mackerel.'},
  jackcrevalle:{name:'Jack Crevalle',min:4,max:35,str:.85,mult:8,color:'#4f6a6e',fact:'Jacks hunt in packs and never quit pulling.'},
  ladyfish:{name:'Ladyfish',min:1,max:4,str:.35,mult:20,color:'#7f9aa0',jump:true,fact:'Ladyfish jump like mini tarpon — the poor man’s tarpon.'},
  sheepshead:{name:'Sheepshead',min:2,max:12,str:.45,mult:14,color:'#c9c9c0',fact:'Sheepshead have human-like teeth for crunching crabs and barnacles off bridge pilings.'},
  pompano:{name:'Florida Pompano',min:1,max:6,str:.4,mult:22,color:'#f1e9b0',fact:'Pompano skip along the surface behind a boat wake — and they are prized table fare.'},
  tripletail:{name:'Tripletail',min:4,max:30,str:.6,mult:14,color:'#4e4434',fact:'Tripletail float on their sides under buoys and debris, pretending to be a leaf.'},
  lionfish:{name:'Lionfish',min:.5,max:3,str:.2,mult:60,color:'#a5432e',fact:'Invasive in Florida. There is no bag limit — every one removed helps the reef.'},
  goliath:{name:'Goliath Grouper',min:100,max:500,str:1.4,mult:4,color:'#6b5c3e',fact:'Protected in Florida apart from a tiny permit lottery — photograph it and let it go.'},
  graytrigger:{name:'Gray Triggerfish',min:2,max:10,str:.45,mult:15,color:'#6f6f68',fact:'Triggerfish lock their first dorsal spine upright to wedge into reef holes.'},
  blacktip:{name:'Blacktip Shark',min:30,max:150,str:1.05,mult:5,color:'#7a8187',jump:true,fact:'Hooked blacktips often spin out of the water.'},
  bullshark:{name:'Bull Shark',min:100,max:350,str:1.35,mult:4,color:'#6b6f68',fact:'Bull sharks roam from the open ocean right up into rivers and canals.'},
  lemonshark:{name:'Lemon Shark',min:60,max:250,str:1.15,mult:4,color:'#a6976b',fact:'Lemon sharks are protected in Florida state waters — release them.'},
  hammerhead:{name:'Great Hammerhead',min:150,max:700,str:1.5,mult:3,color:'#6e7a80',fact:'Great hammerheads must be released in Florida waters.'},
  marlin:{name:'Blue Marlin',min:150,max:800,str:1.45,mult:5,color:'#1f3f8f',jump:true,fact:'The bucket-list billfish of the Gulf Stream. Blue marlin over 300 lb are almost always females.'},
  swordfish:{name:'Swordfish',min:80,max:400,str:1.3,mult:6,color:'#40465a',fact:'Daytime swordfish live near the bottom in well over a thousand feet of water.'},
  blackmarlin:{name:'Black Marlin',min:200,max:900,str:1.55,mult:5,color:'#2b3340',jump:true,fact:'The only marlin whose pectoral fins lock rigidly out to the sides — a true giant, rarely seen this side of the Pacific.'},
  bluerunner:{name:'Blue Runner',min:1,max:8,str:.5,mult:16,color:'#5e8392',fact:'Blue runners travel in big fast schools and make outstanding live bait for everything bigger.'},
  schoolmaster:{name:'Schoolmaster Snapper',min:1,max:8,str:.4,mult:15,color:'#c99a3c',fact:'Named for the way it hangs over patch reef in tight schools. Yellow fins give it away.'},
  lanesnapper:{name:'Lane Snapper',min:.5,max:6,str:.3,mult:17,color:'#d08a74',fact:'Pink with yellow stripes and a smudge under the back — a small, willing reef snapper.'},
  vermilion:{name:'Vermilion Snapper',min:1,max:7,str:.35,mult:16,color:'#b8402e',fact:'Called the beeliner. They stack up in big schools just off the reef drop.'},
  lookdown:{name:'Lookdown',min:.5,max:4,str:.35,mult:20,color:'#c3d2dc',fact:'A living mirror — flat as a plate, with a face that looks permanently unimpressed.'},
  palometa:{name:'Palometa',min:.5,max:3,str:.4,mult:22,color:'#d7d2bd',fact:'The long black fin streamers trail behind it like ribbons in the surf.'},
  spanishmack:{name:'Spanish Mackerel',min:1,max:9,str:.55,mult:14,color:'#44739a',fact:'Golden spots and no bars is how you tell a Spanish from a cero. They slash through bait schools at speed.'},
  bigeye:{name:'Bigeye Tuna',min:30,max:300,str:1.2,mult:7,color:'#24405f',fact:'That enormous eye is for hunting in deep, dark water — bigeye feed far below the other tunas.'},
  skipjack:{name:'Skipjack Tuna',min:4,max:30,str:.8,mult:11,color:'#2b4160',fact:'The striped belly is unique among tunas. Skipjack school in the thousands and churn the surface when they feed.'},
  gag:{name:'Gag Grouper',min:6,max:45,str:.9,mult:7,color:'#6f6a60',fact:'Gags hang over ledges and wrecks; the big ones are almost always males.'},
  redgrouper:{name:'Red Grouper',min:5,max:30,str:.85,mult:7,color:'#9a5a46',fact:'Red groupers dig out holes in the bottom that other reef fish move into.'}
};

export const ZONE_TABLE: Record<string, Array<[string, number]>> = {
  'Creek':[['snook',5],['redfish',3],['tarpon',2],['mangrove',3],['jackcrevalle',2],['ladyfish',2]],
  'Oil Rig':[['amberjack',6],['blackfin',3],['cobia',3],['grouper',1.5],['gag',1.2],['barracuda',2],['kingfish',2.5],['mahi',1.5],['wahoo',1.5],['yellowfin',.8]],
  'Weedline':[['mahi',8],['tripletail',3],['blackfin',2],['graytrigger',2],['wahoo',1],['sailfish',1],['jackcrevalle',1.5]],
  'Flats':[['bonefish',5],['permit',2],['barracuda',3],['tarpon',1],['ladyfish',2],['lemonshark',.8],['blacktip',1],['palometa',1.5]],
  'Backcountry':[['snook',4],['redfish',4],['trout',5],['tarpon',2],['ladyfish',3],['jackcrevalle',2],['tripletail',.8],['bullshark',.6]],
  'Bridge':[['tarpon',5],['mangrove',4],['snook',2],['sheepshead',3],['jackcrevalle',2],['goliath',.6],['bullshark',.6],['lookdown',2],['bluerunner',2.5]],
  'Hawk Channel':[['mangrove',4],['yellowtail',3],['mutton',2],['redgrouper',1.2],['gag',.8],['barracuda',2],['cero',2],['pompano',1.5],['cobia',1],['jackcrevalle',1.5],['graytrigger',1.5],['bluerunner',3],['lanesnapper',2.5],['spanishmack',2.5],['lookdown',1]],
  'Reef':[['yellowtail',5],['mutton',3],['hogfish',3],['grouper',2.5],['gag',2],['redgrouper',2],['barracuda',2],['cero',2.5],['kingfish',2],['lionfish',1.5],['graytrigger',2],['goliath',.4],['schoolmaster',3],['lanesnapper',2.5],['vermilion',2.5],['bluerunner',2.5],['spanishmack',1.5]],
  'Offshore':[['mahi',6],['blackfin',4],['wahoo',2],['sailfish',2],['marlin',1.3],['blackmarlin',.5],['swordfish',1.1],['yellowfin',.8],['albacore',.3],['bluefin',.2],['kingfish',1.5],['amberjack',1.5],['cobia',.5],['hammerhead',.3],['skipjack',3],['bigeye',.5]]
};

/** Species that make a reel-screaming "sounder" run worth announcing (legacy index.html:2662). */
export const SOUNDERS: Set<string> = new Set<string>(['blackfin','yellowfin','bluefin','albacore','amberjack','grouper','goliath','swordfish','cobia','bullshark','hammerhead','lemonshark','blacktip','mutton','kingfish','wahoo']);

/** The three billfish species (legacy index.html:2663). */
export const BILLFISH: Set<string> = new Set<string>(['sailfish','marlin','blackmarlin']);
