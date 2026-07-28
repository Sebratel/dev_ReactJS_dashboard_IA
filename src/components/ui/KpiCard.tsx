import { ReactNode } from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '@/utils/cn'

interface KpiCardProps {
  label: string
  value: string | number
  subtitle?: string
  delta?: number
  deltaLabel?: string
  icon?: ReactNode
  iconColor?: string
  variant?: 'default' | 'danger' | 'success' | 'warning' | 'brand'
  size?: 'sm' | 'md'
  className?: string
}

const VARIANT_STYLES = {
  default: 'border-app-border',
  danger: 'border-risk-critical/20 bg-risk-critical/5',
  success: 'border-risk-low/20 bg-risk-low/5',
  warning: 'border-risk-medium/20 bg-risk-medium/5',
  brand: 'border-brand-blue/20 bg-brand-blue/5',
}

export function KpiCard({ label, value, subtitle, delta, deltaLabel, icon, iconColor = 'text-brand-blue', variant = 'default', size = 'md', className }: KpiCardProps) {
  const isPositive = delta !== undefined && delta > 0
  const isNegative = delta !== undefined && delta < 0

  return (
    <div className={cn('group bg-app-card border border-app-border rounded-2xl p-4 sm:p-5 flex flex-col gap-3 shadow-card transition-[box-shadow,transform,border-color] duration-300 ease-nexa hover:shadow-card-md hover:border-app-borderLight', VARIANT_STYLES[variant], className)}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-[0.08em]">{label}</span>
        {icon && (
          <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center bg-app-surface ring-1 ring-inset ring-app-border', iconColor)}>
            {icon}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        <span className={cn('font-semibold text-gray-100 tabular-nums tracking-tight', size === 'md' ? 'text-2xl' : 'text-lg')}>{value}</span>
        {subtitle && <span className="text-[11px] text-gray-500">{subtitle}</span>}
      </div>

      {delta !== undefined && (
        <div className={cn('flex items-center gap-1 text-[11px] font-medium', isPositive ? 'text-risk-low' : isNegative ? 'text-risk-critical' : 'text-gray-500')}>
          {isPositive ? <TrendingUp size={11} /> : isNegative ? <TrendingDown size={11} /> : <Minus size={11} />}
          <span>{isPositive ? '+' : ''}{delta.toFixed(1)}%</span>
          {deltaLabel && <span className="text-gray-600">{deltaLabel}</span>}
        </div>
      )}
    </div>
  )
}
