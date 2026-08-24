"use client";

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="app-shell"><div className="notice error"><span>页面暂时无法显示，持久化数据没有被清除。</span><button onClick={reset}>重新加载页面</button></div></main>;
}
