import { Package } from './Icons'

export default function EmptyState({ title, description, action, icon: Icon = Package, compact = false }) {
  return (
    <div className={`empty ${compact ? 'empty--compact' : ''}`}>
      <span className="empty__icon">
        <Icon size={compact ? 20 : 24} />
      </span>
      <p className="empty__title">{title}</p>
      {description && <p className="empty__desc">{description}</p>}
      {action}
    </div>
  )
}
