import { useEffect, useState } from 'react'
import './styles/layout.css'
import ImageEditor from './components/ImageEditor/ImageEditor'
import VideoEditor from './components/VideoEditor/VideoEditor'

type Tab = 'image' | 'video'
type Theme = 'light' | 'dark'

function App() {
  const [tab, setTab] = useState<Tab>('image')
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const [visited, setVisited] = useState<Record<Tab, boolean>>({ image: true, video: false })

  useEffect(() => {
    setVisited((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }))
  }, [tab])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            🎛️
          </span>
          <span className="brand-name">MediaForge</span>
        </div>

        <nav className="tabs" role="tablist" aria-label="Editor sections">
          <button
            className={`tab-btn ${tab === 'image' ? 'active' : ''}`}
            role="tab"
            aria-selected={tab === 'image'}
            onClick={() => setTab('image')}
          >
            🖼️ Image Editor
          </button>
          <button
            className={`tab-btn ${tab === 'video' ? 'active' : ''}`}
            role="tab"
            aria-selected={tab === 'video'}
            onClick={() => setTab('video')}
          >
            🎬 Video Editor
          </button>
        </nav>

        <button
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          aria-label="Toggle color theme"
          title="Toggle theme"
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
      </header>

      <main className="main">
        <div className={`panel ${tab === 'image' ? 'active' : ''}`} hidden={tab !== 'image'}>
          {visited.image && <ImageEditor />}
        </div>
        <div className={`panel ${tab === 'video' ? 'active' : ''}`} hidden={tab !== 'video'}>
          {visited.video && <VideoEditor />}
        </div>
      </main>

      <footer className="site-footer">
        <p>All processing happens locally in your browser via WebAssembly. No files ever leave your device.</p>
      </footer>
    </div>
  )
}

export default App
