import tailwind from 'bun-plugin-tailwind';

// Approved exception to AGENTS.md decision 6 (build helpers): the Tailwind plugin runs through
// Bun.build's JS API, so the analyzer builds its web app here instead of with the bun build CLI.
// The package build writes it to dist/web (bun web/build.ts dist/web); serve.ts run from source
// builds it in memory on each page load.
export async function buildWeb(outdir?: string) {
  const result = await Bun.build({
    entrypoints: [new URL('./index.html', import.meta.url).pathname],
    outdir,
    target: 'browser',
    minify: Boolean(outdir),
    naming: { entry: '[name].[ext]', asset: '[name].[ext]', chunk: '[name].[ext]' },
    publicPath: '/',
    plugins: [tailwind]
  });
  if (!result.success) throw new AggregateError(result.logs, 'The web app did not build.');
  return result.outputs;
}

if (import.meta.main) await buildWeb(process.argv[2] ?? 'dist/web');
