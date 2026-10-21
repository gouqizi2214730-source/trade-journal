// 复盘本的标志（替换上游的 LuxAlgo 标志——商标政策不允许衍生版本使用）。
// 保留原组件名以便上游代码无需改动；随主题颜色（currentColor）变化。
export function LuxAlgoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 36" role="img" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <title>复盘本</title>
      <path d="M8 6v10M8 22v8M20 4v6M20 20v12M32 10v8M32 24v6" />
      <rect x="5" y="16" width="6" height="6" rx="1" fill="currentColor" />
      <rect x="17" y="10" width="6" height="10" rx="1" fill="currentColor" />
      <rect x="29" y="18" width="6" height="6" rx="1" fill="currentColor" />
    </svg>
  );
}
