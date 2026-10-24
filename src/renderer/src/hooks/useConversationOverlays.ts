import { useCallback, useRef } from 'react'
import type { RefCallback } from 'react'

/** Keep chat clearance separate from interaction-card clearance: absolute task/
 * queue panels do not increase the composer box. Never replace children/drafts. */
export function useConversationOverlays(hasMetrics: boolean, hasInteractions = false): RefCallback<HTMLDivElement> {
  const disconnect = useRef<(() => void) | undefined>(undefined)
  return useCallback((shell: HTMLDivElement | null) => {
    disconnect.current?.()
    disconnect.current = undefined
    if (!shell) return
    const metrics = hasMetrics ? shell.querySelector<HTMLElement>('.run-metrics-strip') : null
    const composer = shell.querySelector<HTMLElement>('.composer-dock')
    const composerInput = composer?.querySelector<HTMLElement>('.composer-input-scroll')
    let active = true
    let observer: ResizeObserver | undefined
    const supportTargets = new Set<Element>()
    const measure = () => {
      if (!active) return
      const support = composer?.querySelector<HTMLElement>('.composer-support-row')
      const targets = new Set<Element>(support ? [support, ...support.children] : [])
      for (const target of supportTargets) if (!targets.has(target)) {
        observer?.unobserve(target)
        supportTargets.delete(target)
      }
      for (const target of targets) if (!supportTargets.has(target)) {
        observer?.observe(target)
        supportTargets.add(target)
      }
      // In a short dock keep one interaction header reachable. Only constrain
      // the composer when necessary; its normal popovers remain unclipped.
      const supportVisible = support && !support.closest('[hidden], [aria-hidden="true"]')
        && getComputedStyle(support).display !== 'none' && getComputedStyle(support).visibility !== 'hidden'
      const supportRect = supportVisible ? support.getBoundingClientRect() : null
      const supportMaxHeight = Math.max(28, shell.clientHeight - 92)
      shell.style.setProperty('--conversation-support-max-height', `${supportMaxHeight}px`)
      shell.classList.toggle('has-compact-support', Boolean(hasInteractions && supportVisible
        && Math.max(support.scrollHeight, supportRect?.height ?? 0) > supportMaxHeight))
      const supportGap = supportRect && supportRect.width > 0 && supportRect.height > 0 && composer
        ? Math.max(0, composer.getBoundingClientRect().top - supportRect.bottom) : 0
      const supportHeight = supportRect && supportRect.width > 0 && supportRect.height > 0
        ? Math.min(supportRect.height, supportMaxHeight) + supportGap : 0
      const availableHeight = Math.max(0, shell.clientHeight - 80 - (hasInteractions ? supportHeight : 0))
      shell.style.setProperty('--conversation-composer-max-height', `${availableHeight}px`)
      shell.classList.toggle('has-compact-interactions', Boolean(hasInteractions && composerInput
        && composerInput.scrollHeight > availableHeight))
      // The summary has a 6px top margin. Detail is absolute and must never
      // reserve space or resize the message viewport when it expands.
      shell.style.setProperty('--conversation-top-clearance', `${metrics ? metrics.offsetHeight + 6 : 0}px`)
      const composerHeight = composer?.offsetHeight ?? 0
      shell.style.setProperty('--conversation-bottom-clearance', `${composerHeight}px`)
      let interactionHeight = composerHeight
      if (support && !support.closest('[hidden], [aria-hidden="true"]')) {
        const style = getComputedStyle(support)
        const rect = support.getBoundingClientRect()
        if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
          interactionHeight = Math.max(interactionHeight, shell.getBoundingClientRect().bottom - rect.top)
        }
      }
      shell.style.setProperty('--conversation-interaction-bottom-clearance', `${interactionHeight}px`)
    }
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure)
      if (hasInteractions) observer.observe(shell)
      if (metrics) observer.observe(metrics)
      if (composer) observer.observe(composer)
    } else {
      window.addEventListener('resize', measure)
    }
    // Tasks/queue can mount after this ref attached, without resizing composer.
    const mutations = new MutationObserver(measure)
    if (composer) mutations.observe(composer, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden'] })
    measure()
    disconnect.current = () => {
      active = false
      mutations.disconnect()
      observer?.disconnect()
      supportTargets.clear()
      window.removeEventListener('resize', measure)
    }
  }, [hasMetrics, hasInteractions])
}
