import { createApp } from 'vue';
import './styles/md3-tokens.css';
import './styles/app.css';
import { initDynamicThemeBridge } from './core/theme';
import { initSafeAreaBridge } from './core/safeArea';
import App from './App.vue';

// Synchronously apply Android Material You dynamic color tokens and safe-area insets before first paint
initDynamicThemeBridge();
initSafeAreaBridge();

createApp(App).mount('#app');
