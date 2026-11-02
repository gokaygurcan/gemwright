import { navigate } from './router';

// The paperdoll's worn items (src/character-view.ts) are full-size images stacked on one spot, so
// the topmost one's box would catch every hover and click. As the game client does, the item
// under the pointer is the topmost one whose art is opaque there: once the script is running the
// links stop catching the pointer themselves (.pixel-hit), and this marks and opens the hit one.
const pixels = new WeakMap<HTMLImageElement, ImageData | null>();

function opaqueAt(img: HTMLImageElement, x: number, y: number) {
  if (!img.complete || !img.naturalWidth) return false;
  let data = pixels.get(img);
  if (data === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context?.drawImage(img, 0, 0);
    data = context?.getImageData(0, 0, canvas.width, canvas.height) ?? null;
    pixels.set(img, data);
  }
  const rect = img.getBoundingClientRect();
  const px = Math.floor(((x - rect.left) / rect.width) * img.naturalWidth);
  const py = Math.floor(((y - rect.top) / rect.height) * img.naturalHeight);
  if (!data || px < 0 || py < 0 || px >= data.width || py >= data.height) return false;
  return (data.data[(py * data.width + px) * 4 + 3] ?? 0) > 0;
}

function hit(figure: Element, x: number, y: number) {
  const links = [...figure.querySelectorAll<HTMLAnchorElement>('a.layer')].reverse();
  return links.find((link) => {
    const img = link.querySelector('img');
    return img && opaqueAt(img, x, y);
  });
}

let current: HTMLAnchorElement | undefined;
function mark(figure: Element | null, link: HTMLAnchorElement | undefined) {
  if (link === current) return;
  current?.classList.remove('hit');
  current = link;
  link?.classList.add('hit');
  if (figure) (figure as HTMLElement).title = link?.title ?? '';
}

document.addEventListener('pointermove', (event) => {
  const figure = (event.target as Element | null)?.closest?.('.doll .figure') ?? null;
  if (!figure) return mark(null, undefined);
  figure.classList.add('pixel-hit');
  mark(figure, hit(figure, event.clientX, event.clientY));
});

document.addEventListener('click', (event) => {
  const figure = (event.target as Element | null)?.closest?.('.doll .figure.pixel-hit');
  if (!figure || event.button !== 0) return;
  const link = hit(figure, event.clientX, event.clientY);
  const href = link?.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  if (event.metaKey || event.ctrlKey) window.open(href, '_blank');
  else navigate(href);
});
