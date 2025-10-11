import type { Preset } from 'unocss'

import { presetChromatic } from '@proj-airi/unocss-preset-chromatic'
import { defineConfig, mergeConfigs, presetAttributify, presetIcons, presetTypography, presetWebFonts, presetWind3, transformerDirectives, transformerVariantGroup } from 'unocss'
import { presetScrollbar } from 'unocss-preset-scrollbar'

export function safelistAllPrimaryBackgrounds(): string[] {
  return [
    ...[undefined, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((shade) => {
      const prefix = shade ? `bg-primary-${shade}` : `bg-primary`
      return [
        prefix,
        ...[5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(opacity => `${prefix}/${opacity}`),
      ]
    }).flat(),
  ]
}

export function sharedUnoConfig() {
  return defineConfig({
    presets: [
      presetWind3(),
      presetAttributify(),
      presetTypography(),
      presetWebFonts({
        fonts: {
          sans: 'DM Sans',
          serif: 'DM Serif Display',
          mono: 'DM Mono',
        },
        timeouts: {
          warning: 5000,
          failure: 10000,
        },
      }),
      presetIcons({
        scale: 1.2,
      }),
      presetScrollbar(),
      presetChromatic({
        baseHue: 84,
        colors: {
          primary: 0,
          complementary: 180,
        },
      }) as Preset,
    ],
    transformers: [
      transformerDirectives({
        applyVariable: ['--at-apply'],
      }),
      transformerVariantGroup(),
    ],
    // hyoban/unocss-preset-shadcn: Use shadcn ui with UnoCSS
    // https://github.com/hyoban/unocss-preset-shadcn
    //
    // Thanks to
    // https://github.com/unovue/shadcn-vue/issues/34#issuecomment-2467318118
    // https://github.com/hyoban-template/shadcn-vue-unocss-starter
    //
    // By default, `.ts` and `.js` files are NOT extracted.
    // If you want to extract them, use the following configuration.
    // It's necessary to add the following configuration if you use shadcn-vue or shadcn-svelte.
    content: {
      pipeline: {
        include: [
          // the default
          /\.(vue|svelte|[jt]sx|mdx?|astro|elm|php|phtml|html)($|\?)/,
          // include js/ts files
          '(components|src)/**/*.{js,ts,vue}',
        ],
      },
    },
    rules: [
      [/^mask-\[(.*)\]$/, ([, suffix]) => ({ '-webkit-mask-image': suffix.replace(/_/g, ' ') })],
    ],
  })
}

export default mergeConfigs([
  sharedUnoConfig(),
])
