import { resolve } from 'node:path'

import Vue from '@vitejs/plugin-vue'
import Unocss from 'unocss/vite'
import VueRouter from 'unplugin-vue-router/vite'

import { LFS, SpaceCard } from 'hfup/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    // https://github.com/posva/unplugin-vue-router
    VueRouter({
      dts: resolve(import.meta.dirname, 'src', 'typed-router.d.ts'),
      extensions: ['.vue'],
    }),
    Vue(),
    // https://github.com/antfu/unocss
    // see uno.config.ts for config
    Unocss(),

    LFS(),
    SpaceCard({
      root: resolve(import.meta.dirname, '..', '..'),
      title: 'HuggingFace Inspector',
      emoji: '🧐',
      colorFrom: 'yellow',
      colorTo: 'red',
      sdk: 'static',
      header: 'mini',
      pinned: false,
      license: 'mit',
      models: [],
      short_description: 'What\'s inside your .cache/huggingface/hub?',
    }),
  ],
})
