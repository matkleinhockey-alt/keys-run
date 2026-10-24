/**
 * The founders of Keys Run Estates, by the email they sign in with. The founding lots themselves
 * (`FOUNDING_HOLDERS` in packages/shared/src/content/estates.ts) are keyed by a founder label —
 * 'Klein', 'Larry' — which is all the client ever sees; the email that label belongs to stays on
 * the server. Whoever signs in with that email holds the founder's lots, whatever display name
 * they chose, and nobody else does, whatever name they register.
 */
export const FOUNDER_EMAILS: Readonly<Record<string, string>> = {
  Klein: 'matkleinhockey@gmail.com',
  Larry: 'laurent.maltais@gmail.com',
};

/** The founder label for an account's email, or null. Emails are stored lowercased. */
export function founderOf(email: string): string | null {
  const e = email.toLowerCase();
  for (const [name, addr] of Object.entries(FOUNDER_EMAILS)) if (addr === e) return name;
  return null;
}
