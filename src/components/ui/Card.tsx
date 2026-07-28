import { cn } from '@/utils/cn'
import { ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
  glow?: 'blue' | 'danger' | 'success' | 'none'
  hover?: boolean
}

export function Card({ children, className, glow = 'none', hover = false }: CardProps) {
  return (
    <div
      className={cn(
        'bg-app-card border border-app-border rounded-2xl',
        hover && 'hover:border-app-borderLight hover:bg-app-cardHover transition-all duration-200 cursor-default',
        glow === 'blue' && 'shadow-glow',
        glow === 'danger' && 'shadow-glow-danger',
        glow === 'success' && 'shadow-glow-success',
        className
      )}
    >
      {children}
    </div>
  )
}

interface CardHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
  icon?: ReactNode
}

export function CardHeader({ title, subtitle, action, icon }: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-app-border">
      <div className="flex items-center gap-2.5">
        {icon && <div className="text-gray-400">{icon}</div>}
        <div>
          <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
          {subtitle && <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="ml-3 shrink-0">{action}</div>}
    </div>
  )
}
