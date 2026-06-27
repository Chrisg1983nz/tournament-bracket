import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Tournament Bracket',
        short_name: 'Bracket',
        start_url: '/',
        display: 'standalone',
        background_color: '#0D0F14',
        theme_color: '#0D0F14',
        icons: [
          { src: '/favicons.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons.png', sizes: '512x512', type: 'image/png' },
        ]
      }
    })
  ]
})
