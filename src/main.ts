import { createApp } from 'vue';
import './styles/md3-tokens.css';
import './styles/app.css';
import { initDynamicThemeBridge } from './core/theme';
import App from './App.vue';

// Synchronously apply Android Material You dynamic color tokens before first paint
initDynamicThemeBridge();

createApp(App).mount('#app');
