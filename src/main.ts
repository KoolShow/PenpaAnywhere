import { createApp } from 'vue';
import './styles/md3-tokens.css';
import './styles/app.css';
import { initDynamicThemeBridge } from './core/theme';
import { initSafeAreaBridge } from './core/safeArea';
import { detectPlatform } from './core/platform';
import { parseCurrentWindowRole } from './core/multiMonitor';
import App from './App.vue';

const isTauriDesktop = detectPlatform() === 'tauri';
const role = isTauriDesktop ? parseCurrentWindowRole().role : 'main';

// Synchronously apply Android Material You dynamic color tokens and safe-area insets before first paint
initDynamicThemeBridge();
if (role !== 'dock') {
  initSafeAreaBridge();
}

async function bootstrap() {
  if (role === 'viewport') {
    const { default: OverlayViewportApp } = await import('./components/OverlayViewportApp.vue');
    createApp(OverlayViewportApp).mount('#app');
    return;
  }
  if (role === 'dock') {
    const { default: DockSurfaceApp } = await import('./components/DockSurfaceApp.vue');
    createApp(DockSurfaceApp).mount('#app');
    return;
  }
  createApp(App).mount('#app');
}

void bootstrap();
