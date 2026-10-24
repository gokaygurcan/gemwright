import { inflateSync } from 'node:zlib';

export function gumpLayout(packet: Buffer): string {
  if (packet[0] === 0xb0) {
    const length = packet.readUInt16BE(19);
    if (21 + length > packet.length) throw new Error('Truncated gump layout');
    return packet
      .subarray(21, 21 + length)
      .toString('ascii')
      .replace(/\0+$/, '');
  }
  const length = packet.readUInt32BE(19);
  const expanded = packet.readUInt32BE(23);
  if (length < 4 || 23 + length > packet.length || expanded > 2 * 1024 * 1024)
    throw new Error('Invalid packed gump layout');
  const layout = inflateSync(packet.subarray(27, 23 + length), { maxOutputLength: 2 * 1024 * 1024 });
  if (layout.length !== expanded) throw new Error('Truncated expanded gump layout');
  return layout.toString('ascii').replace(/\0+$/, '');
}

export function gumpCommands(layout: string): string[][] {
  return [...layout.matchAll(/\{([^{}]*)\}/g)].map((match) => (match[1] ?? '').trim().split(/\s+/));
}

// The Trammel page of a public moongate menu: the radio beside a destination's localized label.
export function moongateDestination(layout: string, destination: number): number | undefined {
  const commands = gumpCommands(layout);
  if (!commands.some((command) => command.includes('1012011'))) return;
  let page = 0;
  let trammel = false;
  const radios = new Map<string, number>();
  const labels: { page: number; y: string; id: string }[] = [];
  for (const command of commands) {
    if (command[0] === 'page') page = Number(command[1]);
    if (page !== 1) continue;
    if (command.includes('1012012')) trammel = true;
    if (command[0] === 'radio') radios.set(`${page}:${command[2]}`, Number(command[6]));
    if (command[0]?.startsWith('xmfhtmlgump')) labels.push({ page, y: command[2] ?? '', id: command[5] ?? '' });
  }
  const label = labels.find((item) => item.id === String(destination));
  return trammel && label ? radios.get(`${label.page}:${label.y}`) : undefined;
}
