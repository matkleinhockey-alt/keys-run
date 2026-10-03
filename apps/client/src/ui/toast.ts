/**
 * Transient toast messages. Ported from legacy/index.html:3745 `toast(msg)`.
 */
let el: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string): void {
  if (!el) el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => el?.classList.remove('show'), 2600);
}
