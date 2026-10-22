/**
 * Venues of Boot Key Harbor City: what each storefront is, what it says to you at the door, and —
 * the point of this file — what it will SELL once there is an economy to spend in.
 *
 * Pure data, no rendering. The town (apps/client/src/entities/town) builds the buildings from
 * `world/town.ts`'s lots and looks each venue up here by id; a future server-side shop handler can
 * import the same table, which is why `sells` lives here and not next to the three.js meshes.
 *
 * ## The hook (now wired)
 * Every `ShelfItem` is `status: 'live'` and really sells: `sim/shop.ts` validates the purchase
 * against the wallet, puts it in the player's inventory, and collapses everything owned into one
 * flat `Modifiers` bag that each system reads. Nothing outside sim/shop.ts knows an item id, so
 * adding stock is: list it here, map its `effect.key` there. `effect.kind` is the system that
 * consumes the purchase:
 *   - 'gear'       permanently changes the rod / reel / boat (the tackle store)
 *   - 'consumable' a counted item (bait, ice, ammo for the harpoon gun, fuel)
 *   - 'buff'       a timed modifier (a diner breakfast steadies your hands; a bar tab does not)
 *   - 'cosmetic'   changes how you or the boat look
 *   - 'sink'       money out of the economy for flavour (cover charges, tips, a round for the bar)
 *   - 'service'    time/state changes (a motel night skips to sunset and saves)
 *
 * Register: this game has a bikini deck party, a Luigi mode and a seagull who calls you a loser.
 * The strip club is a neon sign, a rope and a bouncer with opinions. Atmosphere over anatomy.
 */

export type VenueId =
  | 'tackle' | 'guns' | 'bar' | 'club' | 'diner'
  | 'dive' | 'liquor' | 'gifts' | 'pawn' | 'laundromat' | 'icecream' | 'motel' | 'convenience';

export type EffectKind = 'gear' | 'consumable' | 'buff' | 'cosmetic' | 'sink' | 'service';

export interface ShelfItem {
  id: string;
  name: string;
  blurb: string;
  /** Whole dollars. Illustrative until the economy lands (content/economy.ts is dock fillet prices). */
  price: number;
  /** 'planned' = listed on the shelf but not for sale. The panel greys it out. */
  status: 'planned' | 'live';
  effect: { kind: EffectKind; key: string };
}

export interface Venue {
  id: VenueId;
  name: string;
  /** One line under the name on the panel, and the sign's small print. */
  tagline: string;
  /** What the counter says when you step up. Picked by index so the same player hears the same line
   * for a visit but a different one next time (the town rotates through `greeting[visit % n]`). */
  greeting: readonly string[];
  /** The panel's body copy: what this place is. */
  blurb: string;
  sells: readonly ShelfItem[];
  /** True when the game offers a door you can walk through; false = exterior and counter only. */
  enterable: boolean;
}

const item = (id: string, name: string, blurb: string, price: number, kind: EffectKind, key: string): ShelfItem =>
  ({ id, name, blurb, price, status: 'live', effect: { kind, key } });

export const VENUES: Readonly<Record<VenueId, Venue>> = {
  tackle: {
    id: 'tackle', name: 'Hook, Line & Sinker Marine Supply', tagline: 'Bait · Tackle · Ice · Advice (free, wrong)',
    greeting: [
      'Welcome in. Tell me what you are chasing and I will sell you the wrong thing with total confidence.',
      'Live shrimp are in the tank by the door. Pilchards are in the freezer. Dignity is not in stock.',
      'You want the good braid or the braid you can afford?',
    ],
    blurb: 'Rods, reels, leader, live bait and bagged ice, run by a man who has opinions about every one of them. This is where better tackle will be bought.',
    sells: [
      item('rod-heavy', 'Heavy-action trolling rod', 'Stops a run the stock rod cannot. Changes the fight sim\'s line strength.', 240, 'gear', 'rod.heavy'),
      item('reel-lever', 'Lever-drag two-speed reel', 'Finer drag steps and a longer spool.', 520, 'gear', 'reel.lever'),
      item('bait-shrimp', 'Live shrimp (dozen)', 'Bite rate up on the flats.', 12, 'consumable', 'bait.shrimp'),
      item('bait-ballyhoo', 'Rigged ballyhoo', 'Trolling bait for mahi and wahoo.', 18, 'consumable', 'bait.ballyhoo'),
      item('ice-bag', 'Bag of ice', 'Keeps the cooler honest.', 4, 'consumable', 'cooler.ice'),
      item('leader-fluoro', '80 lb fluorocarbon leader', 'Fewer bite-offs on toothy fish.', 22, 'consumable', 'leader.fluoro'),
    ],
    enterable: false,
  },
  guns: {
    id: 'guns', name: 'Deadeye Guns & Ammo', tagline: 'Firearms · Ammunition · Spearguns · Pawn',
    greeting: [
      'Spearguns are on the left. Everything on the right is not for fish, and not for you today.',
      'Browsing is free. Dropping things is not.',
      'We do spearguns, flare guns and a very good lecture on both.',
    ],
    blurb: 'A proper Keys gun counter, bars on the windows and a flag out front. In this game it is where the harpoon gun gets its upgrades: longer range, faster shafts, and a reel that does not fight back.',
    sells: [
      item('spear-shaft', 'Stainless spear shafts (3)', 'Replacement shafts for the diver\'s speargun.', 45, 'consumable', 'spear.shafts'),
      item('spear-long', 'Long-range band gun', 'Longer effective range underwater.', 380, 'gear', 'spear.long'),
      item('spear-reel', 'Reel-line conversion', 'A fish on the spear runs less far before you can haul.', 210, 'gear', 'spear.reel'),
      item('flare', 'Marine flare kit', 'Required by the Coast Guard, loved by everyone else.', 38, 'consumable', 'safety.flare'),
    ],
    enterable: false,
  },
  bar: {
    id: 'bar', name: 'The Rusty Anchor', tagline: 'Cold beer · Hot wings · No shirt, no problem',
    greeting: [
      'What\'ll it be? Tell me it is not a light beer.',
      'Fish story? Take a stool. The good ones get a free round. The bad ones get a free round anyway.',
      'You smell like bait and sunscreen. Welcome home.',
    ],
    blurb: 'Weathered boards, a tin roof, a jukebox and a bartender called Dot who has seen every sunburn. A round here will one day cost you Luigi-mode steadiness and buy you hype.',
    sells: [
      item('beer', 'Cold one', 'Lowers your cast accuracy, raises the crowd\'s opinion of you.', 5, 'buff', 'bar.beer'),
      item('round', 'A round for the bar', 'Money out, reputation in.', 60, 'sink', 'bar.round'),
      item('wings', 'Hot wings', 'Balances the cold one. Slightly.', 11, 'buff', 'bar.wings'),
      item('shot-key-lime', 'Key lime shot', 'Local colour.', 8, 'buff', 'bar.shot'),
    ],
    enterable: true,
  },
  club: {
    id: 'club', name: 'Pink Flamingo Cabaret', tagline: 'Live entertainment · Cocktails · Girls girls girls',
    greeting: [
      'Cover is twenty. Flip-flops are fine. Opinions about the show are not.',
      'Private event tonight, fisherman. Come back when the boat is paid off.',
      'VIP is full. Everything is full. Walk it off.',
    ],
    blurb: 'Magenta neon, a velvet rope and a bouncer the size of a bait freezer. You can not get in yet; what you can do is admire the sign and be turned away with some style.',
    sells: [
      item('cover', 'Cover charge', 'Pay to get past the rope.', 20, 'sink', 'club.cover'),
      item('bottle', 'Bottle service', 'A very expensive way to feel important.', 250, 'sink', 'club.bottle'),
      item('tip', 'Tip jar', 'Money out of the economy, for the cabaret.', 10, 'sink', 'club.tip'),
    ],
    enterable: false,
  },
  diner: {
    id: 'diner', name: 'Salty Dog Diner', tagline: 'Breakfast all day · Fresh catch · Pie',
    greeting: [
      'Sit anywhere, hon. Coffee is already coming.',
      'The mahi sandwich is the mahi you sold us last week. You are welcome.',
      'Pie of the day is key lime. Pie of every day is key lime.',
    ],
    blurb: 'Chrome, red vinyl booths and a jukebox that only plays one song. A hot breakfast here will one day steady your hands for the next fight.',
    sells: [
      item('breakfast', 'Fisherman\'s breakfast', 'A buff to line handling for a few minutes.', 14, 'buff', 'diner.breakfast'),
      item('coffee', 'Bottomless coffee', 'A longer, more forgiving strike window.', 3, 'buff', 'diner.coffee'),
      item('mahi-sand', 'Grilled mahi sandwich', 'Stamina for the dive.', 16, 'buff', 'diner.mahi'),
      item('pie', 'Key lime pie', 'Morale. The gull will still call you a loser.', 7, 'buff', 'diner.pie'),
    ],
    enterable: true,
  },
  dive: {
    id: 'dive', name: 'Scuba Steve\'s Dive & Spear', tagline: 'Fills · Gear · Charters',
    greeting: ['Tanks are filled. Your air is your own problem.', 'Dive flag up, always.'],
    blurb: 'Masks, fins, suits and fills. This is where your bottom time comes from — a pony bottle more than doubles it, and the fins and suit stretch what you already have.',
    sells: [
      item('mask-wide', 'Wide-view mask', 'A little more peripheral vision down there.', 90, 'gear', 'dive.mask'),
      item('fins-long', 'Long-blade freediving fins', 'Faster swim, and less air burned per metre.', 140, 'gear', 'dive.fins'),
      item('wetsuit', '3 mm shorty wetsuit', 'Warmth is air. Shivering burns it faster than swimming does.', 160, 'gear', 'dive.wetsuit'),
      item('tank-pony', 'Slung pony bottle and reg', 'The big one: more than twice as long on the bottom.', 900, 'gear', 'dive.tank'),
      item('fill', 'Air fill', 'Tops the bottle back up. Steve will do it while you wait.', 12, 'consumable', 'dive.fill'),
    ],
    enterable: false,
  },
  liquor: {
    id: 'liquor', name: 'Cheap Beer & Lotto', tagline: 'Wine · Spirits · Scratch-offs',
    greeting: ['Cash only after nine.', 'The lotto is up to forty million. The odds are still terrible.'],
    blurb: 'A drive-up bottle shop with a lottery counter. Stock for the bar crowd and the boat\'s cooler.',
    sells: [
      item('sixer', 'Six-pack for the cooler', 'The deck party notices.', 9, 'buff', 'liquor.sixer'),
      item('scratch', 'Scratch-off ticket', 'A tiny chance at a big number.', 5, 'sink', 'liquor.scratch'),
    ],
    enterable: false,
  },
  gifts: {
    id: 'gifts', name: 'Conch Republic Gifts', tagline: 'T-shirts · Shells · Hot sauce',
    greeting: ['Everything here says "Key West". We are in Marathon. Nobody checks.'],
    blurb: 'Shell mirrors, hot sauce and shirts. Cosmetics for the angler land here.',
    sells: [
      item('shirt-hawaiian', 'Loud Hawaiian shirt', 'Changes what you wear ashore.', 35, 'cosmetic', 'cosmetic.shirt.hawaiian'),
      item('cap-conch', 'Conch Republic cap', 'Shade for the head.', 18, 'cosmetic', 'cosmetic.cap.conch'),
    ],
    enterable: false,
  },
  pawn: {
    id: 'pawn', name: 'Keys Pawn & Loan', tagline: 'We buy gold · We buy tackle · No questions',
    greeting: ['Whatever it is, it is worth less than you think.'],
    blurb: 'Used rods, used reels, used regrets. Sell back gear you have outgrown.',
    sells: [item('used-rod', 'Used spinning rod', 'Cheap and cheerful.', 40, 'gear', 'rod.used')],
    enterable: false,
  },
  laundromat: {
    id: 'laundromat', name: 'Suds & Sun Coin Laundry', tagline: 'Wash · Dry · Fold',
    greeting: ['Quarters in the machine by the door.'],
    blurb: 'Nothing here but the warm, sweet smell of fabric softener. A place to wash the fish out of your shorts.',
    sells: [],
    enterable: false,
  },
  icecream: {
    id: 'icecream', name: 'Cone Zone Ice Cream', tagline: 'Soft serve · Key lime · Shakes',
    greeting: ['Waffle cone or cup? Be honest.'],
    blurb: 'Soft-serve in a pastel building shaped like a cone, if you squint.',
    sells: [item('cone', 'Key lime cone', 'Cool off.', 5, 'buff', 'icecream.cone')],
    enterable: false,
  },
  motel: {
    id: 'motel', name: 'Sunset Motor Lodge', tagline: 'Vacancy · Color TV · Ice machine',
    greeting: ['Room 7 is free. It has a view of the other motel.'],
    blurb: 'A two-storey roadside motel with a neon sign that has never once said NO VACANCY. A night here will skip the clock to sunset and save.',
    sells: [item('night', 'One night, room 7', 'Skips to sunset.', 79, 'service', 'motel.night')],
    enterable: false,
  },
  convenience: {
    id: 'convenience', name: 'Stop-N-Go', tagline: 'Gas · Snacks · Live bait (maybe)',
    greeting: ['Gas pump two is broken. So is pump one.'],
    blurb: 'Chips, ice and a lot of fluorescent light. Boat fuel and snacks will be sold here.',
    sells: [
      item('fuel', 'Jerry can of fuel', 'Range for the boat.', 30, 'consumable', 'boat.fuel'),
      item('snacks', 'Chips and a soda', 'Morale.', 4, 'buff', 'conv.snacks'),
    ],
    enterable: false,
  },
};
