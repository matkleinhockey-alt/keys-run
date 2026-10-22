/**
 * Transient toast messages. Ported from legacy/index.html:3745 `toast(msg)`.
 */
let el: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** `ms` defaults to the legacy 2.6 s; a longer line (the pirates' banter runs to ~90 characters)
 * asks for more so it can be read rather than glimpsed. */
export function toast(msg: string, ms = 2600): void {
  if (!el) el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => el?.classList.remove('show'), ms);
}
