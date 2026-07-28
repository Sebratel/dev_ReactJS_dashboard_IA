export function SkeletonCard() {
  return (
    <div className="bg-app-card border border-app-border rounded-2xl p-5 h-28 animate-pulse">
      <div className="h-2.5 w-20 bg-app-border rounded mb-4" />
      <div className="h-6 w-28 bg-app-border rounded" />
    </div>
  )
}
