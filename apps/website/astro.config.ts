import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

import { shardSpecs } from '../../packages/cli/src/commands';

export default defineConfig({
  site: 'https://gemwright.org',
  redirects: { '/docs': '/docs/start/getting-started/' },
  integrations: [
    react(),
    starlight({
      title: 'Gemwright',
      description: 'Forge your own shard',
      logo: { src: './src/assets/forge.png' },
      favicon: '/forge.png',
      customCss: ['./src/styles/theme.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/gokaygurcan/gemwright' }],
      editLink: { baseUrl: 'https://github.com/gokaygurcan/gemwright/edit/main/apps/website/' },
      sidebar: [
        { label: 'Start here', items: [{ autogenerate: { directory: 'docs/start' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'docs/guides' } }] },
        { label: 'Packages', items: [{ autogenerate: { directory: 'docs/packages' } }] },
        {
          label: 'Reference',
          items: [
            {
              label: 'CLI',
              items: [
                { label: 'Overview', link: '/docs/reference/cli/' },
                { label: 'gemwright init', link: '/docs/reference/cli/init/' },
                { label: 'gemwright shard', link: '/docs/reference/cli/shard/' },
                ...Object.keys(shardSpecs).map((name) => ({
                  label: `shard ${name}`,
                  link: `/docs/reference/cli/shard/${name}/`
                }))
              ]
            },
            { label: 'gemwright.json', link: '/docs/reference/configuration/' }
          ]
        }
      ]
    })
  ]
});
