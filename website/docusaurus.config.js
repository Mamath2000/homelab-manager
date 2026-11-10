// @ts-check
// Public documentation site (GitHub Pages): renders ../docs, the same pages the private homelab site syncs from this repo.

import {themes as prismThemes} from 'prism-react-renderer';

const repoUrl = 'https://github.com/Mamath2000/homelab-manager';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Homelab Manager',
  tagline: "Une seule interface pour savoir si ton homelab va bien",

  future: {
    v4: true,
  },

  url: 'https://mamath2000.github.io',
  baseUrl: '/homelab-manager/',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {onBrokenMarkdownLinks: 'throw'},
  },

  plugins: [
    [
      '@cmfcmf/docusaurus-search-local',
      /** @type {import('@cmfcmf/docusaurus-search-local').PluginOptions} */
      ({
        indexDocs: true,
        indexPages: false,
        indexBlog: false,
        language: 'fr',
      }),
    ],
  ],

  i18n: {
    defaultLocale: 'fr',
    locales: ['fr'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: '../docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.js',
          editUrl: ({docPath}) => `${repoUrl}/edit/main/docs/${docPath}`,
        },
        blog: false,
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'Homelab Manager',
        items: [
          {href: repoUrl, label: 'GitHub', position: 'right'},
          {href: `${repoUrl}/blob/main/CHANGELOG.md`, label: 'Changelog', position: 'right'},
        ],
      },
      footer: {
        style: 'dark',
        copyright: `Homelab Manager — <a href="${repoUrl}">${repoUrl.replace('https://', '')}</a>`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'yaml', 'json', 'go'],
      },
    }),
};

export default config;
