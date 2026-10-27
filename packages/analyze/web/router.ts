import { useEffect, useState } from 'preact/hooks';

// In-browser routing: links within the app change the address without reloading the page.
const listeners = new Set<() => void>();
const current = () => `${location.pathname}${location.search}`;

export function navigate(to: string, replace = false) {
  if (to === current()) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.scrollTo(0, 0);
  for (const listener of listeners) listener();
}

export function useLocation() {
  const [path, setPath] = useState(current());
  useEffect(() => {
    const update = () => setPath(current());
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

// Plain links anywhere on the page, server-made markup included, route in the app; a modified
// click (new tab) or a link elsewhere behaves as usual.
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  const anchor = (event.target as Element | null)?.closest?.('a');
  const href = anchor?.getAttribute('href');
  if (!anchor || !href?.startsWith('/') || anchor.target || anchor.hasAttribute('download')) return;
  event.preventDefault();
  navigate(href);
});
