import { lookup } from 'node:dns/promises';
import { connect, isIP } from 'node:net';

import { shellQuote } from './shell';
import type { VpsOptions } from './vps-deploy';

const MINIMUM_FREE_KIB = 10 * 1024 * 1024;

export interface HostReport {
  freeKib: number;
  listening?: number[];
  sudo: boolean;
  docker: boolean;
  memoryKib?: number;
}

export const hostReportScript = (destination: string) => `set -eu
path=${shellQuote(destination)}
while [ ! -e "$path" ]; do path=$(dirname "$path"); done
echo "disk $(df -Pk "$path" | awk 'NR==2 {print $4}')"
echo "memory $(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
if command -v ss >/dev/null 2>&1; then echo "ports $(ss -ltnH | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\\n' ' ')"; fi
if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then echo 'sudo yes'; else echo 'sudo no'; fi
if docker info >/dev/null 2>&1; then echo 'docker yes'; else echo 'docker no'; fi`;

export function parseHostReport(output: string): HostReport {
  const fields = new Map(
    output.split('\n').map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)])
  );
  const ports = fields.get('ports');
  return {
    freeKib: Number(fields.get('disk')),
    ...(ports === undefined ? {} : { listening: ports.split(/\s+/).filter(Boolean).map(Number) }),
    ...(Number(fields.get('memory')) ? { memoryKib: Number(fields.get('memory')) } : {}),
    sudo: fields.get('sudo') === 'yes',
    docker: fields.get('docker') === 'yes'
  };
}

export function hostProblems(
  report: HostReport,
  options: VpsOptions,
  deployed: boolean,
  interactive: boolean,
  warn: (message: string) => void = console.warn
): string[] {
  const problems: string[] = [];
  // Measured on a ServUO shard with a full world: about 1 GB in use, and a restart on a 1.9 GB
  // server had a process killed for memory.
  if (report.memoryKib && report.memoryKib < 2 * 1024 * 1024)
    warn(
      `The VPS has ${Math.floor(report.memoryKib / 1024)} MiB of memory. A shard with a full world uses about 1 GB and can run out during restarts; AI residents need more.`
    );
  if (!(report.freeKib >= MINIMUM_FREE_KIB))
    problems.push(`The VPS needs at least 10 GiB free; it has ${Math.floor(report.freeKib / 1024 / 1024)} GiB.`);
  // A redeployment's own services hold these ports.
  if (!deployed) {
    const busy = [2593, ...(options.client ? [80, 443] : [])].filter((port) => report.listening?.includes(port));
    if (busy.length) problems.push(`Another service is using port ${busy.join(', ')} on the VPS.`);
  }
  const needsRoot = options.installDeps || !report.docker;
  if (needsRoot && !report.sudo && !interactive)
    problems.push('This deployment needs sudo: configure passwordless sudo, or run it from a terminal.');
  return problems;
}

// The address may legitimately differ behind a proxy, so only an unresolved name stops a deployment.
export async function dnsProblems(
  options: VpsOptions,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true, family: 4 })).map((entry) => entry.address),
  warn: (message: string) => void = console.warn
): Promise<string[]> {
  const addresses = async (host: string) => (isIP(host) ? [host] : resolve(host).catch(() => undefined));
  const login = await addresses(options.publicHost ?? '');
  const problems = login?.length ? [] : [`${options.publicHost} does not resolve to an IPv4 address.`];
  if (options.client && options.domain) {
    const web = await addresses(options.domain);
    if (!web?.length) problems.push(`${options.domain} does not resolve; HTTPS certificates need its DNS record.`);
    else if (login?.length && !web.some((address) => login.includes(address)))
      warn(
        `${options.domain} resolves to ${web.join(', ')}, not ${login.join(', ')}. HTTPS needs it to reach the VPS.`
      );
  }
  return problems;
}

export async function preflight(
  options: VpsOptions,
  destination: string,
  deployed: boolean,
  run: (script: string) => Promise<string>,
  interactive = !!process.stdin.isTTY
) {
  const report = parseHostReport(await run(hostReportScript(destination)));
  const problems = [...hostProblems(report, options, deployed, interactive), ...(await dnsProblems(options))];
  if (problems.length)
    throw new Error(`Nothing was changed.\n${problems.join('\n')}\nRun gemwright shard setup to prepare the server.`);
}

// Players connect from outside, so the deploying machine checks the port the same way; a port the
// server listens on but nobody reaches is almost always a firewall in front of it.
export async function reachable(host: string, port: number, attempts = 12, delayMs = 5000) {
  const connects = () =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host, port, timeout: 5000 });
      const done = (open: boolean) => {
        socket.destroy();
        resolve(open);
      };
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await connects()) return;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `The shard runs, but ${host}:${port} is unreachable from here. Open TCP ${port} in any firewall in front of the server, such as your provider's, then rerun.`
  );
}
