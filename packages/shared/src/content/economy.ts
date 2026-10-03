/**
 * Dock economics: rough fillet prices and species that can't be sold.
 *
 * Ported faithfully from legacy/index.html lines 2908-2911. Every value preserved exactly.
 */

// rough dock prices for fillets, $/lb (illustrative); game fish, billfish and protected species can't be sold
export const MEAT_PRICE: Record<string, number> = {mahi:12,blackfin:10,yellowfin:14,bluefin:25,albacore:9,wahoo:14,swordfish:16,yellowtail:14,mutton:13,mangrove:12,grouper:18,gag:18,redgrouper:17,hogfish:22,cobia:15,
  kingfish:7,cero:7,amberjack:8,pompano:14,tripletail:14,sheepshead:8,trout:9,redfish:10,lionfish:16,graytrigger:12,blacktip:4,jackcrevalle:2,ladyfish:1};

export const NO_SALE: Record<string, string> = {marlin:'Billfish — release only, no sale',blackmarlin:'Billfish — release only, no sale',sailfish:'Billfish — release only, no sale',tarpon:'Game fish — no commercial sale',bonefish:'Game fish — no commercial sale',
  snook:'Game fish — no commercial sale',permit:'Game fish — no commercial sale',goliath:'Protected — must be released',hammerhead:'Protected — must be released',bullshark:'Not sold for food',lemonshark:'Not sold for food',barracuda:'Not sold — ciguatera risk'};
