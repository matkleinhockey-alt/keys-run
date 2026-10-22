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
  /** Whole dollars. See PRICING below: gear is priced in "effective sessions" against measured income. */
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

/**
 * ## PRICING (why the numbers on the shelves are what they are)
 *
 * Measured with apps/client/test/playthrough-economy.mjs (real shared fight sim, fixed seed, 'angler'
 * player, SIMULATED seconds). On the starter outfit (braid50) 30 sim-minutes of rod time pays, in
 * dollars: Hawk Channel ~$11.1k, Reef ~$12.5k, Offshore ~$21.0k. That is an upper bound on a human
 * (perfect 250 ms reactions, no missed strikes, no town trips), so a design "session" here is
 * 15 rod-minutes at 60% realism = 0.3 x that table: **~$3.75k at the Reef, ~$6.3k offshore**, i.e.
 * about $250 per effective minute inshore. Everything below is quoted in that unit.
 *
 * Tiers, by design:
 *   - pocket    (< 1 min):   consumables, food, cosmetics. Flavour, not progression.
 *   - first buy (~1-3 min):  mask, fins, wetsuit. The cheap dive kit (1,600) is a first-session purchase,
 *                            so the shops never read as locked.
 *   - the fork  (~1 session): pony bottle 4,500 / lever reel 4,000 / a first hull at 9,000. Roughly the
 *                            second half-hour of play; you can afford ~one of them, not all, and they pay
 *                            back in different currencies (dive time / fish per minute / status).
 *   - sinks:                 priced to cost a visible slice of a session, or they are not sinks.
 * Every gear price was set from a payback of ~2-5 effective sessions on the lift `modifiersFor` gives it
 * (rod/reel lifts measured in the harness; dive/spear lifts priced by analogy, because the harness does
 * not model spearing). Rejected: leaving them at the original 90-900, which put the ENTIRE gear shelf
 * (2,680 dollars) at under one session of income, so there was nothing to choose between, and a
 * pony bottle cost a quarter of a session while a hull cost two.
 */
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
      // PRICE 240 -> 2,400. lineMul 1.35 on the starter braid50 = 67 lb. Measured (playthrough-economy.mjs, 30 sim-min): Hawk
      // +1%, Reef +1%, Offshore +21% ($21.0k -> $25.4k). It is an offshore tool: ~$1.3k per effective session there, so
      // 2,400 pays back in ~2 offshore sessions (~5 if you stay inshore). At 240 it was 4 minutes of income.
      item('rod-heavy', 'Heavy-action trolling rod', 'Stops a run the stock rod cannot. Changes the fight sim\'s line strength.', 2_400, 'gear', 'rod.heavy'),
      // PRICE 520 -> 4,000. reelMul 1.3 + lineMul 1.05. The best single rod-side buy: Hawk +13%, Reef +11%, Offshore +25%
      // (faster retrieve = more fish per minute AND fewer losses). ~$0.8k per effective session blended, so 4,000 is a ~5-session
      // payback (2.5 if you fish offshore). Deliberately dearer than the heavy rod because it helps at EVERY range.
      // Together heavy+lever (6,400) measure the same lift as the braid80 rung (+42% offshore), which is why braid80 is
      // now 6,500 in content/tackle.ts rather than 12,000: otherwise the rung would be strictly dominated by $760 of town gear.
      item('reel-lever', 'Lever-drag two-speed reel', 'Finer drag steps and a longer spool.', 4_000, 'gear', 'reel.lever'),
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
      // PRICE 380 -> 2,200. +6 m on SPEAR_RANGE 18 is +33% reach = ~1.8x the water a shot covers. Spear income is not in the
      // rod harness, so this is priced by analogy to the lever reel (the other 'more fish per minute' item), a notch under it.
      item('spear-long', 'Long-range band gun', 'Longer effective range underwater.', 2_200, 'gear', 'spear.long'),
      // PRICE 210 -> 1,400. Tether x0.6 saves fish that would otherwise strip the tether; a landing aid, not a rate boost, so
      // cheaper than the long gun but a real purchase (~1/3 of a session).
      item('spear-reel', 'Reel-line conversion', 'A fish on the spear runs less far before you can haul.', 1_400, 'gear', 'spear.reel'),
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
      // SINKS: PRICE 60 -> 250. A sink only works if it costs a visible slice of a session. 60 was ~15 seconds of income. 250 = 1 effective minute.
      item('round', 'A round for the bar', 'Money out, reputation in.', 250, 'sink', 'bar.round'),
      item('wings', 'Hot wings', 'Balances the cold one. Slightly.', 11, 'buff', 'bar.wings'),
      item('shot-key-lime', 'Key lime shot', 'Local colour.', 8, 'buff', 'bar.shot'),
    ],
    enterable: true,
  },
  club: {
    id: 'club', name: 'Pink Flamingo Cabaret', tagline: 'Live entertainment · Cocktails · Under new management',
    greeting: [
      'Evening, boss. Rope is down, booth is yours, nobody charges you a nickel.',
      'Boss is in! Hey — somebody get the good glasses.',
      'Your club, your rules. Try not to tell the band how to play.',
    ],
    blurb: 'Magenta neon, a velvet rope and a bouncer the size of a bait freezer. You own the place, which is why the rope comes down and the tab does not exist. The house still takes everyone else\'s money; yours is already in the till.',
    sells: [
      // Cover and bottle are COMPED for the owner (sim/club.ts): they stay listed because the club
      // still charges everyone else, and the panel shows them at $0 with "on the house" rather
      // than hiding them — a shelf that silently empties reads as broken, not as a perk.
      item('cover', 'Cover charge', 'Pay to get past the rope. Not you.', 50, 'sink', 'club.cover'),
      item('bottle', 'Bottle service', 'A very expensive way to feel important.', 2_500, 'sink', 'club.bottle'),
      item('tip', 'Tip jar', 'The band and the staff still get paid. Tip them.', 10, 'sink', 'club.tip'),
    ],
    enterable: true,
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
      // PRICE 90 -> 250. +6 m of view is pure convenience (no income of its own) so it stays the cheapest dive buy and the FIRST
      // thing a new player can afford: ~1 effective minute of Reef income, i.e. inside the first session. 90 was 20 seconds.
      item('mask-wide', 'Wide-view mask', 'A little more peripheral vision down there.', 250, 'gear', 'dive.mask'),
      // PRICE 140 -> 600. Swim +28% and breath +8%: a comfort item that quietly helps every dive. ~2.5 effective minutes.
      item('fins-long', 'Long-blade freediving fins', 'Faster swim, and less air burned per metre.', 600, 'gear', 'dive.fins'),
      // PRICE 160 -> 750. breath x1.18 is worth more than the fins' x1.08 and stacks with the bottle (x2.2 x1.18 x1.08 = 2.8x),
      // so it costs more than the fins. Still under 1/4 of a session: the cheap kit (mask+fins+wetsuit = 1,600) is a first-session buy.
      item('wetsuit', '3 mm shorty wetsuit', 'Warmth is air. Shivering burns it faster than swimming does.', 750, 'gear', 'dive.wetsuit'),
      // PRICE 900 -> 4,500. breath x2.2 is the biggest single multiplier in the shop. Set just ABOVE the lever reel (4,000) and
      // about half a Robalo (9,000) so the early fork is real: ~session 3 you can have the bottle, or the reel, or be 50% of the
      // way to a hull, and each wins on a different axis (dive time vs fish/minute vs status). 900 was a quarter of one session.
      item('tank-pony', 'Slung pony bottle and reg', 'The big one: more than twice as long on the bottom.', 4_500, 'gear', 'dive.tank'),
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
    blurb: 'The warm, sweet smell of fabric softener. A place to wash the fish out of your shorts, and the bar out of your shirt.',
    sells: [
      item('wash', 'Wash & dry', 'Takes the bar out of your shirt. And you.', 8, 'service', 'laundromat.wash'),
      item('sock', 'Lost-and-found sock', 'A mystery sock. Eight to collect. Nothing happens.', 3, 'sink', 'laundromat.sock'),
    ],
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
      // DELISTED. There is no fuel tank in sim/boat.ts, and the services agent's reasoning for
      // not inventing one is right: a tank that can run dry strands you mid-ocean, and a tank that
      // cannot is a gauge that never matters. Left listed it would have charged $30 for a can that
      // does nothing — the same inert-purchase failure already fixed twice. Off the shelf until
      // there is a fuel system worth having.
      { ...item('fuel', 'Jerry can of fuel', 'Range for the boat.', 30, 'consumable', 'boat.fuel'), status: 'planned' as const },
      item('snacks', 'Chips and a soda', 'Morale.', 4, 'buff', 'conv.snacks'),
    ],
    enterable: false,
  },
};
