import {defineConfig} from 'vite';
import motionCanvas from '@motion-canvas/vite-plugin';

export default defineConfig({
  server: {
    host: '127.0.0.1',
  },
  plugins: [motionCanvas()],
});
