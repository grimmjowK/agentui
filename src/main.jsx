import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'
import { applyFontPreferences } from './utils/fontPreferences'
import { isLLMProvider } from '../shared/providers'

// 首帧前套用界面字体偏好，避免字体跳变
applyFontPreferences()

// 已下线的 provider（如 gemini）残留在 localStorage 会让 PROVIDER_INFO 查询抛错白屏；
// 所有读取点都回退 'claude'，在入口清掉一次即可
try {
  const storedProvider = localStorage.getItem('selected-provider')
  if (storedProvider !== null && !isLLMProvider(storedProvider)) {
    localStorage.removeItem('selected-provider')
  }
} catch {
  // localStorage 不可用时各读取点自行回退
}

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
