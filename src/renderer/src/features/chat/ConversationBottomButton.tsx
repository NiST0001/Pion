import { ArrowDown } from 'lucide-react'

interface ConversationBottomButtonProps {
  visible: boolean
  disabled?: boolean
  onClick: () => void
  hidden?: boolean
}

export function ConversationBottomButton({ visible, disabled, onClick, hidden }: ConversationBottomButtonProps) {
  const concealed = !visible || Boolean(hidden)
  return <button
    type="button"
    className="icon-button conversation-bottom-button"
    aria-label="回到底部"
    title="回到底部"
    hidden={concealed}
    inert={concealed || undefined}
    disabled={disabled}
    onClick={onClick}
  >
    <ArrowDown size={16} aria-hidden="true" />
  </button>
}
