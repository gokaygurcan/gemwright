import tailwind from 'bun-plugin-tailwind';

// The app's one build, with Tailwind (the bun build CLI does not take plugins yet): the package
// build writes it to dist/web (bun web/build.ts dist/web), and serve.ts run from source builds it
// in memory on each page load.
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
